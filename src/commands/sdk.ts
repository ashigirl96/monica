import { events, type SdkSessionOpened } from "./bindings";

export function onSdkSessionOpened(cb: (payload: SdkSessionOpened) => void) {
  return events.sdkSessionOpened.listen((e) => cb(e.payload));
}
