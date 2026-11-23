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

	readonly calls: string[] = [];
	readonly negotiatedChannels: any[] = [];
	primaryChannel: any;
	closed = false;

	constructor() {
		FakePeerConnection.instance = this;
	}

	createDataChannel(label: string, init: RTCDataChannelInit) {
		if (!init.negotiated) {
			this.calls.push("create primary");
			this.primaryChannel = {
				label,
				id: FakePeerConnection.reportedPrimaryId,
				readyState: "connecting",
			};
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
		this.calls.push("create reliable");
		const channel = { label, id: init.id, readyState: "connecting" };
		this.negotiatedChannels.push(channel);
		return channel;
	}

	createOffer() {
		this.calls.push("create offer");
		return new Promise(() => {});
	}

	setRemoteDescription() {
		this.calls.push("set remote description");
		return new Promise(() => {});
	}

	close() {
		this.closed = true;
	}
}

const fakeProvider = () =>
	({
		options: { config: {} },
		socket: { send() {} },
		emitError() {},
		_removeConnection() {},
	}) as any;

const createConnection = () =>
	new Raw("remote", fakeProvider(), { reliable: false });

const createAnsweringConnection = () =>
	new Raw("remote", fakeProvider(), {
		connectionId: "dc_answering",
		_payload: { sdp: { type: "offer", sdp: "" } },
	});

const openChannel = (channel: any) => {
	channel.readyState = "open";
	channel.onopen();
};

const binaryMessage = (bytes: number[]) =>
	({ data: new Uint8Array(bytes).buffer }) as MessageEvent;

describe("DataConnection reliable channel", () => {
	beforeEach(() => {
		(globalThis as any).RTCPeerConnection = FakePeerConnection;
		(globalThis as any).RTCSessionDescription = class {};
		FakePeerConnection.reportedPrimaryId = 1;
		FakePeerConnection.createThrows = null;
	});

	it("exists before the offer on the peer that connects", () => {
		createConnection();

		expect(FakePeerConnection.instance.calls).toEqual([
			"create reliable",
			"create primary",
			"create offer",
		]);
	});

	it("exists before the offer is applied on the peer that answers", () => {
		createAnsweringConnection();

		expect(FakePeerConnection.instance.calls).toEqual([
			"create reliable",
			"set remote description",
		]);
	});

	it("receives binary data before anything has opened", () => {
		createConnection();

		expect(FakePeerConnection.instance.negotiatedChannels[0].binaryType).toBe(
			"arraybuffer",
		);
	});

	it("opens when the browser reports null for the primary channel id", () => {
		FakePeerConnection.reportedPrimaryId = null;
		const connection = createConnection();
		const onOpen = jest.fn();
		connection.on("open", onOpen);

		openChannel(FakePeerConnection.instance.primaryChannel);
		openChannel(FakePeerConnection.instance.negotiatedChannels[0]);

		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(connection.open).toBe(true);
	});

	it.each([null, 0, 1, 5])(
		"requests the same id whatever the browser reports for the primary channel (%s)",
		(reportedId) => {
			FakePeerConnection.reportedPrimaryId = reportedId;
			createConnection();

			expect(FakePeerConnection.instance.negotiatedChannels[0].id).toBe(2);
		},
	);

	it("waits for the primary channel when the reliable channel opens first", () => {
		const connection = createConnection();
		const onOpen = jest.fn();
		connection.on("open", onOpen);
		const peerConnection = FakePeerConnection.instance;

		openChannel(peerConnection.negotiatedChannels[0]);
		expect(onOpen).not.toHaveBeenCalled();
		expect(connection.open).toBe(false);

		openChannel(peerConnection.primaryChannel);
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(connection.open).toBe(true);
	});

	it("opens once when the answering peer gets its primary channel last", () => {
		const connection = createAnsweringConnection();
		const onOpen = jest.fn();
		connection.on("open", onOpen);
		const reliable = FakePeerConnection.instance.negotiatedChannels[0];

		openChannel(reliable);
		expect(onOpen).not.toHaveBeenCalled();

		const primary: any = { readyState: "connecting" };
		connection._initializeDataChannel(primary);
		openChannel(primary);

		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it("hands over reliable messages from before the connection opened, in order, after open", () => {
		const connection = createConnection();
		const events: unknown[] = [];
		connection.on("open", () => events.push("open"));
		connection.on("data", (data) => events.push(data));
		const peerConnection = FakePeerConnection.instance;
		const reliable = peerConnection.negotiatedChannels[0];

		openChannel(reliable);
		reliable.onmessage(binaryMessage([1]));
		reliable.onmessage(binaryMessage([2]));
		expect(events).toEqual([]);

		openChannel(peerConnection.primaryChannel);
		reliable.onmessage(binaryMessage([3]));

		expect(events).toEqual([
			"open",
			new Uint8Array([1]).buffer,
			new Uint8Array([2]).buffer,
			new Uint8Array([3]).buffer,
		]);
	});

	it("drops held messages when closed from an open listener", () => {
		const connection = createConnection();
		const onData = jest.fn();
		connection.on("open", () => connection.close());
		connection.on("data", onData);
		const peerConnection = FakePeerConnection.instance;
		const reliable = peerConnection.negotiatedChannels[0];

		openChannel(reliable);
		reliable.onmessage(binaryMessage([1]));
		openChannel(peerConnection.primaryChannel);

		expect(onData).not.toHaveBeenCalled();
	});

	it("closes with a surfaced error when the channel cannot be created", async () => {
		FakePeerConnection.createThrows = new DOMException(
			"RTCDataChannel creation failed",
			"OperationError",
		);
		const connection = createConnection();
		const errors: any[] = [];
		connection.on("error", (error) => errors.push(error));
		const peerConnection = FakePeerConnection.instance;

		await Promise.resolve();

		expect(errors).toHaveLength(1);
		expect(errors[0].type).toBe(DataConnectionErrorType.ReliableChannelFailed);
		expect(errors[0].message).toContain("OperationError");
		expect(errors[0].message).toContain("RTCDataChannel creation failed");
		expect(peerConnection.calls).toEqual([]);
		expect(peerConnection.closed).toBe(true);
		expect(connection.open).toBe(false);
	});

	it("does not answer when the channel cannot be created", async () => {
		FakePeerConnection.createThrows = new DOMException(
			"RTCDataChannel creation failed",
			"OperationError",
		);
		createAnsweringConnection();
		const peerConnection = FakePeerConnection.instance;

		await Promise.resolve();

		expect(peerConnection.calls).toEqual([]);
		expect(peerConnection.closed).toBe(true);
	});

	it("stays open when the primary channel fires open twice", () => {
		const connection = createConnection();
		const onOpen = jest.fn();
		connection.on("open", onOpen);
		const peerConnection = FakePeerConnection.instance;

		openChannel(peerConnection.negotiatedChannels[0]);
		openChannel(peerConnection.primaryChannel);
		openChannel(peerConnection.primaryChannel);

		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(peerConnection.negotiatedChannels).toHaveLength(1);
		expect(peerConnection.closed).toBe(false);
	});
});
