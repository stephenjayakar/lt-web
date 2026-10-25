/**
 * ogg-length.ts — True sample length of an Ogg Vorbis file, read from the
 * container, and trimming of decoded buffers to it.
 *
 * Vorbis decodes in whole blocks; the encoder marks where the audio really
 * ends with the granule position of the stream's last page, and a conforming
 * decoder (libvorbisfile, stb_vorbis — what pygame/SDL_mixer use for Lex
 * Talionis) discards the samples past it. Chrome's decodeAudioData does not:
 * it returns up to a block of extra samples at the end, which the engine's
 * looping music then plays at every loop point. AudioManager trims each
 * decoded buffer to the length found here.
 */

export interface OggVorbisLength {
  /** Sample frames per channel (granule position of the last page) */
  frames: number;
  sampleRate: number;
  channels: number;
}

const GRANULE_UNSET_LO = 0xffffffff;

/**
 * Parse the Ogg pages of a Vorbis stream: sample rate and channels from the
 * identification header, length from the last page's granule position.
 * Returns null for anything that is not a well-formed Ogg Vorbis file (MP3,
 * WAV, truncated data, other codecs).
 */
export function oggVorbisLength(bytes: Uint8Array): OggVorbisLength | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let serial: number | null = null;
  let sampleRate = 0;
  let channels = 0;
  let frames = -1;

  while (offset + 27 <= bytes.length) {
    if (bytes[offset] !== 0x4f || bytes[offset + 1] !== 0x67 || bytes[offset + 2] !== 0x67 || bytes[offset + 3] !== 0x53) {
      return null; // not "OggS": not Ogg, or corrupt
    }
    const granuleLo = view.getUint32(offset + 6, true);
    const granuleHi = view.getUint32(offset + 10, true);
    const pageSerial = view.getUint32(offset + 14, true);
    const segments = bytes[offset + 26];
    const headerLen = 27 + segments;
    if (offset + headerLen > bytes.length) return null;
    let bodyLen = 0;
    for (let i = 0; i < segments; i++) bodyLen += bytes[offset + 27 + i];
    const body = offset + headerLen;
    if (body + bodyLen > bytes.length) break; // truncated final page: use what we have

    if (serial === null) {
      // First page: the Vorbis identification header (packet type 1, "vorbis").
      if (bodyLen < 16 || bytes[body] !== 0x01 ||
          String.fromCharCode(...bytes.subarray(body + 1, body + 7)) !== 'vorbis') {
        return null;
      }
      serial = pageSerial;
      channels = bytes[body + 11];
      sampleRate = view.getUint32(body + 12, true);
    } else if (pageSerial === serial && !(granuleLo === GRANULE_UNSET_LO && granuleHi === GRANULE_UNSET_LO)) {
      frames = granuleHi * 0x100000000 + granuleLo;
    }
    offset = body + bodyLen;
  }

  if (serial === null || frames < 0 || sampleRate <= 0 || channels <= 0) return null;
  return { frames, sampleRate, channels };
}

/**
 * The buffer cut to the stream's true length, converted to the buffer's
 * (context) sample rate — decodeAudioData resamples. Returns the input when
 * it is not longer than that.
 */
export function trimToTrueLength(
  buffer: AudioBuffer,
  length: OggVorbisLength,
  createBuffer: (channels: number, frames: number, sampleRate: number) => AudioBuffer,
): AudioBuffer {
  const target = Math.round(length.frames * buffer.sampleRate / length.sampleRate);
  if (target <= 0 || target >= buffer.length) return buffer;
  const trimmed = createBuffer(buffer.numberOfChannels, target, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    trimmed.copyToChannel(buffer.getChannelData(ch).subarray(0, target), ch);
  }
  return trimmed;
}
