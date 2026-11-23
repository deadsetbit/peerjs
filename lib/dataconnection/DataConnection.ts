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
	data: (data: unknown, reliable: boolean) => void;
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
	/**
	 * Both peers must create the reliable channel on the same stream id. It is created first and reserves
	 * id 2, and the primary channel then takes 0 or 1. WebKit <= 15 reports null for the id of a channel
	 * it created, so the id cannot be derived from the primary channel's.
	 * Older versions of this fork used the primary channel's id + 1, which is also 2 in practice.
	 */
	private static readonly RELIABLE_CHANNEL_ID = 2;

	private _negotiator: Negotiator<DataConnectionEvents, this>;
	abstract readonly serialization: string;
	readonly reliable: boolean;
	protected reliableDataChannel: RTCDataChannel;
	private _reliableMessagesBeforeOpen: MessageEvent[] = [];

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

	protected abstract _handleDataMessage(
		e: MessageEvent,
		reliable: boolean,
	): void;

	/**
	 * Called by the Negotiator before anything is negotiated. A negotiated channel has no handshake, so
	 * the remote peer can send on it as soon as the transport is up, and a browser silently drops what
	 * arrives on a stream that has no channel yet. Creating it here means it is there first, on both peers.
	 *
	 * @returns false when the channel could not be created and the connection is about to close.
	 */
	_createReliableDataChannel(): boolean {
		// This "reliableDataChannel" is a custom hack to be able to have two data channels as PeerJS only supports one.
		// Instead of having this "reliableDataChannel", an improvement could be allowing any number of data channels to be defined in options of peer.connect().
		// It would allow user to define multiple data channels, each created up front like this one.
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
		try {
			this.reliableDataChannel = this.peerConnection.createDataChannel(
				this.connectionId + "__reliable",
				{
					ordered: true,
					negotiated: true,
					id: DataConnection.RELIABLE_CHANNEL_ID,
				},
			);
		} catch (err) {
			// Later, because this runs in the constructor and nobody can be listening for the error yet.
			queueMicrotask(() => {
				// A string, because PeerError loses the name and message of a DOMException.
				this.emitError(
					DataConnectionErrorType.ReliableChannelFailed,
					`Creating the reliable data channel failed: ${err}`,
				);
				this.close();
			});
			return false;
		}
		this.reliableDataChannel.binaryType = "arraybuffer";

		this.reliableDataChannel.onmessage = (e) => {
			logger.log(`DC#${this.connectionId} dc onmessage:`, e.data);
			if (!this._open) {
				this._reliableMessagesBeforeOpen.push(e);
				return;
			}
			this._handleDataMessage(e, true);
		};

		this.reliableDataChannel.onopen = () => {
			logger.log(`DC#${this.connectionId} reliable dc connection open`);
			this._openWhenBothChannelsAreOpen();
		};
		this.reliableDataChannel.onclose = () => {
			logger.log(`DC#${this.connectionId} reliable dc connection closed`);
			if (this._open) {
				this.close();
			}
		};

		return true;
	}

	/**
	 * The channels open in either order: on the answering peer the primary channel does not even exist
	 * until after the reliable one has opened. Users may send on either channel from `open`, and on the
	 * answering peer they only start listening for `data` from `open`, so messages wait for it.
	 */
	private _openWhenBothChannelsAreOpen(): void {
		if (
			this._open ||
			this.dataChannel?.readyState !== "open" ||
			this.reliableDataChannel?.readyState !== "open"
		) {
			return;
		}

		this._open = true;
		this.emit("open");

		while (this._open && this._reliableMessagesBeforeOpen.length > 0) {
			this._handleDataMessage(this._reliableMessagesBeforeOpen.shift(), true);
		}
	}

	/** Called by the Negotiator when the DataChannel is ready. */
	override _initializeDataChannel(dc: RTCDataChannel): void {
		this.dataChannel = dc;

		this.dataChannel.onopen = () => {
			logger.log(`DC#${this.connectionId} dc connection open`);
			this._openWhenBothChannelsAreOpen();
		};

		this.dataChannel.onmessage = (e) => {
			logger.log(`DC#${this.connectionId} dc onmessage:`, e.data);
			this._handleDataMessage(e, false);
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
		this._reliableMessagesBeforeOpen = [];

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
