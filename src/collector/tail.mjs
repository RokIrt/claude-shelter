// Incremental reader for an append-only JSONL file. Node only.
import fs from 'node:fs';

const CHUNK = 1 << 20;
const NEWLINE = 0x0a;

/**
 * Remembers how far a file has been read and hands out only the complete lines
 * appended since. A partial last line (the writer is mid-append) is left for the
 * next poll. Splitting is done on bytes, so a multi-byte character cut by a chunk
 * boundary is never decoded in halves.
 */
export class JsonlTail {
  constructor(file) {
    this.file = file;
    this.offset = 0;      // byte position just past the last complete line consumed
    this.ino = null;
    this.exists = false;
  }

  /**
   * @param {(line:string)=>void} onLine called for every new complete, non-empty line
   * @param {()=>void} [onReset] called first when the file shrank or was replaced, i.e.
   *   everything read so far must be forgotten because it is about to be delivered again
   * @returns {number} bytes consumed
   */
  poll(onLine, onReset) {
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
    } catch {
      this.exists = false;
      return 0;
    }
    try {
      const st = fs.fstatSync(fd);
      this.exists = true;
      if (st.size < this.offset || (this.ino != null && st.ino !== this.ino)) {
        this.offset = 0;
        onReset?.();
      }
      this.ino = st.ino;
      if (st.size <= this.offset) return 0;

      const start = this.offset;
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, st.size - start));
      let pending = [];   // pieces of a line that spans chunks
      let pendingBytes = 0;
      let pos = start;
      while (pos < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - pos), pos);
        if (n <= 0) break;
        const view = buf.subarray(0, n);
        let from = 0;
        for (;;) {
          const nl = view.indexOf(NEWLINE, from);
          if (nl === -1) break;
          let line;
          if (pendingBytes) {
            pending.push(Buffer.from(view.subarray(from, nl)));
            line = Buffer.concat(pending).toString('utf8');
            pending = [];
            pendingBytes = 0;
          } else {
            line = view.toString('utf8', from, nl);
          }
          from = nl + 1;
          if (line.trim()) onLine(line);
        }
        if (from < n) {
          pending.push(Buffer.from(view.subarray(from, n)));
          pendingBytes += n - from;
        }
        pos += n;
      }
      this.offset = pos - pendingBytes;
      return this.offset - start;
    } finally {
      fs.closeSync(fd);
    }
  }
}
