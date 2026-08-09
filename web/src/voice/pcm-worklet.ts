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
    if (ch && ch.length) this.port.postMessage(ch.slice(0)); // copy: the buffer is reused after process()
    return true;
  }
}
registerProcessor('pcm-forwarder', PcmForwarder);
