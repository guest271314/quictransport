async function quicTransportAudioWorkletMemoryGrow(text) {
  const url = 'quic-transport://localhost:4433/tts';
  try {
    const transport = new QuicTransport(url);
    await transport.ready;
    transport.closed
      .then((_) => {
        console.log('Connection closed normally.');
      })
      .catch((e) => {
        console.error(e.message);
        console.trace();
      });
    const sender = await transport.createSendStream();
    const writer = sender.writable.getWriter();
    const encoder = new TextEncoder('utf-8');
    let data = encoder.encode(text);
    await writer.write(data);
    console.log('writer close', await writer.close());
    const reader = transport.receiveStreams().getReader();
    const result = await reader.read();
    if (result.done) {
      console.log(result);
      return;
    }
    let stream = result.value;
    console.log({ stream });
    const { readable } = stream;
    const ac = new AudioContext({
      sampleRate: 11025,
      latencyHint: 1,
    });
    const initial = (384 * 512 * 3) / 65536; // 3 seconds
    const maximum = (384 * 512 * 60 * 60) / 65536; // 1 hour
    let started = false;
    let readOffset = 0;
    let init = false;
    const memory = new WebAssembly.Memory({
      initial,
      maximum,
      shared: true,
    });
    console.log(memory.buffer.byteLength, initial / 65536);
    const msd = new MediaStreamAudioDestinationNode(ac);
    const { stream: mediaStream } = msd;
    const [track] = mediaStream.getAudioTracks();
    const source = new MediaStreamAudioSourceNode(ac, { mediaStream });
    track.onmute = track.onunmute = track.onended = (e) => console.log(e);
    mediaStream.oninactive = (e) => console.log(e);
    ac.onstatechange = (e) => console.log(ac.state);
    class AudioWorkletProcessor {}
    class AudioWorkletQuicTransportStream extends AudioWorkletProcessor {
      constructor(options) {
        super(options);
        console.log(this);
        Object.assign(this, options.processorOptions);
        this.port.onmessage = (e) => {
          Object.assign(this, e.data);
          console.log(this);
        };
      }
      process(inputs, outputs) {
        if (this.writeOffset >= this.memory.buffer.byteLength && !this.ended) {
          console.log(this.readOffset, this.writeOffset);
          this.ended = true;
          this.endOfStream();
          return false;
        }
        const channels = outputs.flat();
        const uint8 = new Uint8Array(512);
        const uint8_sab = new Uint8Array(this.memory.buffer); // .slice(this.writeOffset, this.writeOffset + 512)
        try {
          for (let i = 0; i < 512; i++) {
            if (
              !this.started ||
              this.writeOffset > this.memory.buffer.byteLength
            ) {
              uint8[i] = 0;
            } else {
              uint8[i] = uint8_sab[this.writeOffset];
              ++this.writeOffset;
            }
          }
          const uint16 = new Uint16Array(uint8.buffer);
          // https://stackoverflow.com/a/35248852
          for (let i = 0, j = 0, n = 1; i < uint16.length; i++) {
            const int = uint16[i];
            // If the high bit is on, then it is a negative number, and actually counts backwards.
            const float =
              int >= 0x8000 ? -(0x10000 - int) / 0x8000 : int / 0x7fff;
            // interleave
            channels[(n = ++n % 2)][!n ? j++ : j - 1] = float;
          }
        } catch (e) {
          console.error(e);
          throw e;
          return false;
        }
        return true;
      }
      endOfStream() {
        this.port.postMessage({
          currentTime,
          currentFrame,
          started: this.started,
          ended: this.ended,
          readOffset: this.readOffset,
          writeOffset: this.writeOffset,
        });
      }
    }
    // register processor in AudioWorkletGlobalScope
    function registerProcessor(name, processorCtor) {
      return `console.log(globalThis);\n${processorCtor};\nregisterProcessor('${name}', ${processorCtor.name});`;
    }
    const worklet = URL.createObjectURL(
      new Blob(
        [
          registerProcessor(
            'audio-worklet-quic-transport-stream',
            AudioWorkletQuicTransportStream
          ),
        ],
        { type: 'text/javascript' }
      )
    );
    await ac.audioWorklet.addModule(worklet);
    aw = new AudioWorkletNode(ac, 'audio-worklet-quic-transport-stream', {
      numberOfInputs: 1,
      numberOfOutputs: 2,
      channelCount: 2,
      processorOptions: {
        readOffset: 0,
        writeOffset: 0,
        ended: false,
        started: false,
      },
    });

    aw.onprocessorerror = async (e) => {
      aw.disconnect();
      msd.disconnect();
      await ac.suspend();
      await reader.cancel();
      await transport.close();
      console.error(e);
      console.trace();
    };
    let resolve;
    const promise = new Promise(async (_) => {
      resolve = _;
    });
    aw.port.onmessage = async (e) => {
      console.log(e.data);
      if (e.data.ended) {
        msd.disconnect();
        source.disconnect();
        aw.disconnect();
        track.stop();
        resolve(ac.close());
      }
    };
    aw.connect(msd);
    source.connect(ac.destination);
    aw.port.postMessage({ memory });
    await ac.resume();

    function int16ToFloat32(inputArray) {
      const output = new Float32Array(inputArray.length);
      for (let i = 0; i < output.length; i++) {
        const int = inputArray[i];
        // If the high bit is on, then it is a negative number, and actually counts backwards.
        const float = int >= 0x8000 ? -(0x10000 - int) / 0x8000 : int / 0x7fff;
        output[i] = float;
      }
      return output;
    }
    
    // TODO: handle clipping of resulting audio duration less than 2 seconds, 
    // e.g., inputs "a", "hello", "1";
    // reading the entire SharedArrayBuffer in AudioWorklet instead of 
    // halting audio processing after writeOffset > readOffset resulting
    // in 1+ seconds of silent plaback after expected audio output to prevent
    // clipping at end of playback;
    // determine why the same data is streamed twice if more than one stream is read
    
    await readable.pipeTo(
      new WritableStream(
        {
          start() {
            console.log('writable start');
          },
          async write(value, controller) {
            console.log(value, value.byteLength, memory.buffer.byteLength);

            if (readOffset + value.byteLength > memory.buffer.byteLength) {
              console.log('before grow', memory.buffer.byteLength);
              memory.grow(3);
              console.log('after grow', memory.buffer.byteLength);
            }
            const uint8_sab = new Uint8Array(memory.buffer);

            let i = 0;
            if (!init) {
              init = true;
              i = 44;
            }
            for (
              ;
              i < value.buffer.byteLength;
              i++, readOffset++
            ) {
              uint8_sab[readOffset] = value[i];
            }
            if (readOffset > 384 * 512 && !started) {
              started = true;
              aw.port.postMessage({ started: true });
            }
          },
          close() {
            aw.port.postMessage({ readOffset });
            console.log(readOffset, memory.buffer.byteLength);
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: 384 * 512 * 3 })
      )
    );
    await promise;
    console.log({ reader, transport });
    await reader.cancel();
    await transport.close();

    console.log(await reader.closed, await stream.readingAborted, gc());
  } catch (e) {
    console.error(e);
    console.trace();
  }
}
