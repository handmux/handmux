// Minimal AudioWorklet: forward each render quantum's mono samples to the main thread, which does the
// (unit-tested) downsample/frame/encode. Kept trivial on purpose — worklet code can't be unit-tested.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][]): boolean;
}

declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class PcmForwarder extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      // Send an ArrayBuffer rather than a realm-owned typed-array wrapper: AudioWorklet runs in a separate
      // JS realm, where prototype identity is not a portable message contract. Transfer also avoids the
      // second structured-clone copy; the render quantum's original buffer remains untouched.
      const copy = ch.slice(0);
      this.port.postMessage(copy.buffer, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-forwarder', PcmForwarder);
