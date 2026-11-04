import "./setup";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { DataConnectionErrorType } from "../lib/enums";
import { Raw } from "../lib/dataconnection/BufferedConnection/Raw";

/**
 * Behaves as libwebrtc does for the primary channel of a connection the player opened:
 * the in-band channel already holds sid 1, so a negotiated channel on sid 1 throws.
 */
class FakePeerConnection {
	static instance: FakePeerConnection;
	static reportedPrimaryId: number | null = 1;
	static createThrows: Error | null = null;

	readonly negotiatedChannels: any[] = [];
	primaryChannel: any;
	closed = false;

	constructor() {
		FakePeerConnection.instance = this;
	}

	createDataChannel(label: string, init: RTCDataChannelInit) {
		if (!init.negotiated) {
			this.primaryChannel = { label, id: FakePeerConnection.reportedPrimaryId };
			return this.primaryChannel;
		}
		if (FakePeerConnection.createThrows) {
			throw FakePeerConnection.createThrows;
		}
		if (init.id === 1) {
			throw new DOMException(
				"The operation is not supported.",
				"NotSupportedError",
			);
		}
		const channel = { label, id: init.id };
		this.negotiatedChannels.push(channel);
		return channel;
	}

	createOffer() {
		return new Promise(() => {});
	}

	close() {
		this.closed = true;
	}
}

const createConnection = () =>
	new Raw(
		"remote",
		{
			options: { config: {} },
			socket: { send() {} },
			emitError() {},
			_removeConnection() {},
		} as any,
		{ reliable: false },
	);

describe("DataConnection reliable channel", () => {
	beforeEach(() => {
		(globalThis as any).RTCPeerConnection = FakePeerConnection;
		FakePeerConnection.reportedPrimaryId = 1;
		FakePeerConnection.createThrows = null;
	});

	it("opens when the browser reports null for the primary channel id", () => {
		FakePeerConnection.reportedPrimaryId = null;
		const connection = createConnection();
		const onOpen = jest.fn();
		connection.on("open", onOpen);

		FakePeerConnection.instance.primaryChannel.onopen();
		FakePeerConnection.instance.negotiatedChannels[0].onopen();

		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(connection.open).toBe(true);
	});

	it.each([null, 0, 1, 5])(
		"requests the same id whatever the browser reports for the primary channel (%s)",
		(reportedId) => {
			FakePeerConnection.reportedPrimaryId = reportedId;
			createConnection();

			FakePeerConnection.instance.primaryChannel.onopen();

			expect(FakePeerConnection.instance.negotiatedChannels[0].id).toBe(2);
		},
	);

	it("closes with a surfaced error when the channel cannot be created", () => {
		FakePeerConnection.createThrows = new DOMException(
			"RTCDataChannel creation failed",
			"OperationError",
		);
		const connection = createConnection();
		const errors: any[] = [];
		connection.on("error", (error) => errors.push(error));
		const peerConnection = FakePeerConnection.instance;

		expect(() => peerConnection.primaryChannel.onopen()).not.toThrow();

		expect(errors).toHaveLength(1);
		expect(errors[0].type).toBe(DataConnectionErrorType.ReliableChannelFailed);
		expect(errors[0].message).toContain("OperationError");
		expect(errors[0].message).toContain("RTCDataChannel creation failed");
		expect(peerConnection.closed).toBe(true);
		expect(connection.open).toBe(false);
	});

	it("keeps the channel when the primary channel fires open twice", () => {
		const connection = createConnection();
		const errors: unknown[] = [];
		connection.on("error", (error) => errors.push(error));
		const peerConnection = FakePeerConnection.instance;

		peerConnection.primaryChannel.onopen();
		peerConnection.primaryChannel.onopen();

		expect(peerConnection.negotiatedChannels).toHaveLength(1);
		expect(errors).toHaveLength(0);
		expect(peerConnection.closed).toBe(false);
	});
});
