import { BufferedConnection } from "./BufferedConnection";
import { SerializationType } from "../../enums";

export class Raw extends BufferedConnection {
	readonly serialization = SerializationType.None;

	protected _handleDataMessage({ data }) {
		super.emit("data", data);
	}

	override _send(data, _chunked, reliable) {
		this._bufferedSend(data, reliable);
	}
}
