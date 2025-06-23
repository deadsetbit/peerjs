import { BufferedConnection } from "./BufferedConnection";
import { SerializationType } from "../../enums";

export class Raw extends BufferedConnection {
	readonly serialization = SerializationType.None;

	protected _handleDataMessage({ data }, reliable: boolean) {
		super.emit("data", data, reliable);
	}

	override _send(data, _chunked, reliable) {
		this._bufferedSend(data, reliable);
	}
}
