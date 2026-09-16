// AudioWorkletProcessor for mic capture. Runs on the browser's dedicated
// real-time audio thread, not the main thread -- unlike the ScriptProcessorNode
// it replaces, DOM work, Chart.js rendering, or any other main-thread jank
// during a call can't stall or drop audio callbacks here.
//
// process() is called by the spec in fixed 128-sample quanta; we buffer those
// up to a larger chunk before handing off to the main thread, so downstream
// resampling/PCM conversion still works on ~4096-sample blocks as before.
class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 4096;
    this.buffer = new Float32Array(this.chunkSize);
    this.writeIndex = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.writeIndex++] = channel[i];
        if (this.writeIndex === this.chunkSize) {
          // .slice() copies out of the reusable buffer before posting --
          // the underlying memory gets overwritten starting next sample.
          this.port.postMessage(this.buffer.slice());
          this.writeIndex = 0;
        }
      }
    }
    return true; // keep the processor alive for the life of the call
  }
}

registerProcessor("mic-capture-processor", MicCaptureProcessor);
