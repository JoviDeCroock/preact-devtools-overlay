/**
 * Fixed-capacity log. Every pushed item gets a monotonically increasing
 * sequence number, so callers can ask for "everything after seq N" even
 * after older items were evicted.
 */
export class RingBuffer<T> {
	#items: Array<{ seq: number; value: T }> = [];
	#nextSeq: () => number;
	#last = 0;
	/** Number of items evicted so far. */
	dropped = 0;

	/**
	 * @param nextSeq Source of sequence numbers. Pass a shared counter to make
	 * cursors comparable across several buffers.
	 */
	constructor(
		readonly capacity: number,
		nextSeq?: () => number,
	) {
		let seq = 0;
		this.#nextSeq = nextSeq ?? (() => ++seq);
	}

	push(value: T): number {
		const seq = (this.#last = this.#nextSeq());
		this.#items.push({ seq, value });
		if (this.#items.length > this.capacity) {
			this.#items.shift();
			this.dropped++;
		}
		return seq;
	}

	/** Sequence number of the newest item ever pushed (0 if none). */
	get lastSeq(): number {
		return this.#last;
	}

	get size(): number {
		return this.#items.length;
	}

	/** Items with `seq >= since`, oldest first, at most the newest `last`. */
	read({ since = 0, last }: { since?: number; last?: number } = {}): Array<{
		seq: number;
		value: T;
	}> {
		let out = this.#items;
		if (since > 0) {
			// Items are sorted by seq, so skip ahead.
			const first = out.findIndex(item => item.seq >= since);
			out = first === -1 ? [] : out.slice(first);
		}
		if (last !== undefined && last >= 0 && out.length > last) {
			out = out.slice(out.length - last);
		}
		return out === this.#items ? out.slice() : out;
	}

	clear() {
		this.#items = [];
	}
}
