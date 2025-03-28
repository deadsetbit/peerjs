import { BaseConnection, type BaseConnectionEvents } from "../baseconnection";
import {
	BaseConnectionErrorType,
	ConnectionType,
	DataConnectionErrorType,
	ServerMessageType,
} from "../enums";
import logger from "../logger";
import { Negotiator } from "../negotiator";
import type { Peer } from "../peer";
import type { EventsWithError } from "../peerError";
import type { ServerMessage } from "../servermessage";
import { randomToken } from "../utils/randomToken";

export interface DataConnectionEvents
	extends EventsWithError<DataConnectionErrorType | BaseConnectionErrorType>,
		BaseConnectionEvents<DataConnectionErrorType | BaseConnectionErrorType> {
	/**
	 * Emitted when data is received from the remote peer.
	 */
	data: (data: unknown) => void;
	/**
	 * Emitted when the connection is established and ready-to-use.
	 */
	open: () => void;
}

/**
 * Wraps a DataChannel between two Peers.
 */
export abstract class DataConnection extends BaseConnection<
	DataConnectionEvents,
	DataConnectionErrorType
> {
	protected static readonly ID_PREFIX = "dc_";
	protected static readonly MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;

	private _negotiator: Negotiator<DataConnectionEvents, this>;
	abstract readonly serialization: string;
	readonly reliable: boolean;
	protected reliableDataChannel: RTCDataChannel;

	public get type() {
		return ConnectionType.Data;
	}

	constructor(peerId: string, provider: Peer, options: any) {
		super(peerId, provider, options);

		this.connectionId =
			this.options.connectionId || DataConnection.ID_PREFIX + randomToken();

		this.label = this.options.label || this.connectionId;
		this.reliable = !!this.options.reliable;

		this._negotiator = new Negotiator(this);

		this._negotiator.startConnection(
			this.options._payload || {
				originator: true,
				reliable: this.reliable,
			},
		);
	}

	protected abstract _handleDataMessage(e: MessageEvent): void;

	/** Called by the Negotiator when the DataChannel is ready. */
	override _initializeDataChannel(dc: RTCDataChannel): void {
		this.dataChannel = dc;

		this.dataChannel.onopen = () => {
			logger.log(
				`DC#${this.connectionId} dc connection open. Waiting for reliable dc connection open...`,
			);

			// This "reliableDataChannel" is a custom hack to be able to have two data channels as PeerJS only supports one.
			// Instead of having this "reliableDataChannel", an improvement could be allowing any number of data channels to be defined in options of peer.connect().
			// It would allow user to define multiple data channels to be instantiated after the primary data channel is opened and negotiated.
			// -
			// Example:
			// const connection = peer.connect(peerId, {
			// 		reliable: false,
			// 		metadata: connectMetadata,
			// 		label: `connection_${this.connectionCounter}`,
			// 		dataChannels: [
			// 			{
			// 				label: "reliable",
			// 				dataChannelOptions: {
			// 					ordered: true,
			//				},
			//			},
			//			...
			//		],
			//	});
			// });
			this.reliableDataChannel = this.peerConnection.createDataChannel(
				this.connectionId + "__reliable",
				{
					ordered: true,
					negotiated: true,
					id: this.dataChannel.id + 1,
				},
			);
			this.reliableDataChannel.binaryType = this.dataChannel.binaryType;

			this.reliableDataChannel.onmessage = (e) => {
				logger.log(`DC#${this.connectionId} dc onmessage:`, e.data);
				this._handleDataMessage(e);
			};

			this.reliableDataChannel.onopen = () => {
				logger.log(`DC#${this.connectionId} reliable dc connection open`);
				this._open = true;
				this.emit("open");
			};
			this.reliableDataChannel.onclose = () => {
				logger.log(`DC#${this.connectionId} reliable dc connection closed`);
				if (this._open) {
					this.close();
				}
			};
		};

		this.dataChannel.onmessage = (e) => {
			logger.log(`DC#${this.connectionId} dc onmessage:`, e.data);
			this._handleDataMessage(e);
		};

		this.dataChannel.onclose = () => {
			logger.log(`DC#${this.connectionId} dc closed for:`, this.peer);
			this.close();
		};
	}

	/**
	 * Exposed functionality for users.
	 */

	/** Allows user to close connection. */
	close(options?: { flush?: boolean }): void {
		if (options?.flush) {
			this.send({
				__peerData: {
					type: "close",
				},
			});
			return;
		}
		if (this._negotiator) {
			this._negotiator.cleanup();
			this._negotiator = null;
		}

		if (this.provider) {
			this.provider._removeConnection(this);

			this.provider = null;
		}

		if (this.dataChannel) {
			this.dataChannel.onopen = null;
			this.dataChannel.onmessage = null;
			this.dataChannel.onclose = null;
			this.dataChannel = null;
		}

		if (this.reliableDataChannel) {
			this.reliableDataChannel.onopen = null;
			this.reliableDataChannel.onmessage = null;
			this.reliableDataChannel.onclose = null;
			this.reliableDataChannel = null;
		}

		if (!this.open) {
			return;
		}

		this._open = false;

		super.emit("close");
	}

	protected abstract _send(
		data: any,
		chunked: boolean,
		reliable: boolean,
	): void | Promise<void>;

	/** Allows user to send data. */
	public send(data: any, chunked = false, reliable = false) {
		if (!this.open) {
			this.emitError(
				DataConnectionErrorType.NotOpenYet,
				"Connection is not open. You should listen for the `open` event before sending messages.",
			);
			return;
		}
		return this._send(data, chunked, reliable);
	}

	async handleMessage(message: ServerMessage) {
		const payload = message.payload;

		switch (message.type) {
			case ServerMessageType.Answer:
				await this._negotiator.handleSDP(message.type, payload.sdp);
				break;
			case ServerMessageType.Candidate:
				await this._negotiator.handleCandidate(payload.candidate);
				break;
			default:
				logger.warn(
					"Unrecognized message type:",
					message.type,
					"from peer:",
					this.peer,
				);
				break;
		}
	}
}
