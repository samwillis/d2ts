import { DefaultMap, chunkedArrayPush, hash, createTuple, releaseTuple } from './utils.js'
import { MemoryEfficientStream } from './types.js'

export type MultiSetArray<T> = [T, number][]
export type KeyedData<T> = [key: string, value: T]

/**
 * Common interface for MultiSet implementations
 */
export interface IMultiSet<T> {
  /**
   * Apply a function to all records in the collection.
   */
  map<U>(f: (data: T) => U): IMultiSet<U>

  /**
   * Filter out records for which a function f(record) evaluates to False.
   */
  filter(f: (data: T) => boolean): IMultiSet<T>

  /**
   * Negate all multiplicities in the collection.
   */
  negate(): IMultiSet<T>

  /**
   * Concatenate two collections together.
   */
  concat(other: IMultiSet<T>): IMultiSet<T>

  /**
   * Produce as output a collection that is logically equivalent to the input
   * but which combines identical instances of the same record into one
   * (record, multiplicity) pair.
   */
  consolidate(): IMultiSet<T>

  /**
   * Extend this collection with data from another collection
   */
  extend(other: IMultiSet<T> | MultiSetArray<T>): void

  /**
   * Get an iterator over the elements
   */
  [Symbol.iterator](): Iterator<[T, number]>

  /**
   * Get all entries as an array
   */
  getInner(): MultiSetArray<T>

  /**
   * String representation
   */
  toString(indent?: boolean): string

  /**
   * JSON representation
   */
  toJSON(): string
}

/**
 * A tuple-free iterator that yields data and multiplicity separately
 * to avoid tuple allocations entirely
 */
export interface TupleFreeIterator<T> {
  next(): { done: boolean; value?: { data: T; multiplicity: number } }
  [Symbol.iterator](): TupleFreeIterator<T>
}

/**
 * A multiset of data.
 */
export class MultiSet<T> implements IMultiSet<T> {
  #inner: MultiSetArray<T>

  constructor(data: MultiSetArray<T> = []) {
    this.#inner = data
  }

  toString(indent = false): string {
    return `MultiSet(${JSON.stringify(this.#inner, null, indent ? 2 : undefined)})`
  }

  toJSON(): string {
    return JSON.stringify(Array.from(this.getInner()))
  }

  static fromJSON<T>(json: string): MultiSet<T> {
    return new MultiSet(JSON.parse(json))
  }

  /**
   * Get an iterator over the elements
   */
  *[Symbol.iterator](): Iterator<[T, number]> {
    for (const entry of this.#inner) {
      yield entry
    }
  }

  /**
   * Apply a function to all records in the collection.
   */
  map<U>(f: (data: T) => U): IMultiSet<U> {
    return new MultiSet(
      this.#inner.map(([data, multiplicity]) => [f(data), multiplicity]),
    )
  }

  /**
   * Filter out records for which a function f(record) evaluates to False.
   */
  filter(f: (data: T) => boolean): IMultiSet<T> {
    return new MultiSet(this.#inner.filter(([data, _]) => f(data)))
  }

  /**
   * Negate all multiplicities in the collection.
   */
  negate(): IMultiSet<T> {
    return new MultiSet(
      this.#inner.map(([data, multiplicity]) => [data, -multiplicity]),
    )
  }

  /**
   * Concatenate two collections together.
   */
  concat(other: IMultiSet<T>): IMultiSet<T> {
    const out: MultiSetArray<T> = []
    chunkedArrayPush(out, this.#inner)
    chunkedArrayPush(out, other.getInner())
    return new MultiSet(out)
  }

  /**
   * Produce as output a collection that is logically equivalent to the input
   * but which combines identical instances of the same record into one
   * (record, multiplicity) pair.
   */
  consolidate(): IMultiSet<T> {
    const consolidated = new DefaultMap<string | number, number>(() => 0)
    const values = new Map<string, any>()

    let hasString = false
    let hasNumber = false
    let hasOther = false
    for (const [data, _] of this.#inner) {
      if (typeof data === 'string') {
        hasString = true
      } else if (typeof data === 'number') {
        hasNumber = true
      } else {
        hasOther = true
        break
      }
    }

    const requireJson = hasOther || (hasString && hasNumber)

    for (const [data, multiplicity] of this.#inner) {
      const key = requireJson ? hash(data) : (data as string | number)
      if (requireJson && !values.has(key as string)) {
        values.set(key as string, data)
      }
      consolidated.update(key, (count) => count + multiplicity)
    }

    const result: MultiSetArray<T> = []
    for (const [key, multiplicity] of consolidated.entries()) {
      if (multiplicity !== 0) {
        const parsedKey = requireJson ? values.get(key as string) : key
        result.push([parsedKey as T, multiplicity])
      }
    }

    return new MultiSet(result)
  }

  extend(other: IMultiSet<T> | MultiSetArray<T>): void {
    const otherArray = other instanceof MultiSet || 'getInner' in other ? other.getInner() : other
    chunkedArrayPush(this.#inner, otherArray)
  }

  getInner(): MultiSetArray<T> {
    return this.#inner
  }
}

/**
 * A lazy multiset that uses generators to compute results on-demand
 */
export class LazyMultiSet<T> implements IMultiSet<T> {
  #generator: () => Generator<[T, number], void, unknown>

  constructor(generator: () => Generator<[T, number], void, unknown>) {
    this.#generator = generator
  }

  toString(indent = false): string {
    const data = Array.from(this)
    return `LazyMultiSet(${JSON.stringify(data, null, indent ? 2 : undefined)})`
  }

  toJSON(): string {
    return JSON.stringify(Array.from(this))
  }

  /**
   * Get an iterator over the elements
   */
  *[Symbol.iterator](): Iterator<[T, number]> {
    yield* this.#generator()
  }

  /**
   * Get a tuple-free iterator that yields data and multiplicity separately
   */
  tupleFreeIterator(): TupleFreeIterator<T> {
    const generator = this.#generator()
    return {
      next() {
        const result = generator.next()
        if (result.done) {
          return { done: true }
        }
        const [data, multiplicity] = result.value
        return { done: false, value: { data, multiplicity } }
      },
      [Symbol.iterator]() {
        return this
      }
    }
  }

  /**
   * Apply a function to all records in the collection.
   */
  map<U>(f: (data: T) => U): IMultiSet<U> {
    const sourceGenerator = this.#generator
    return new LazyMultiSet(function* () {
      for (const [data, multiplicity] of sourceGenerator()) {
        const tuple = createTuple(f(data), multiplicity)
        yield tuple
        // Note: We don't release the tuple here because it's being yielded
        // The consumer is responsible for releasing it
      }
    })
  }

  /**
   * Map operation that doesn't allocate tuples
   */
  mapTupleFree<U>(f: (data: T) => U): TupleFreeIterator<U> {
    const sourceGenerator = this.#generator
    const generator = (function* (): Generator<{ data: U; multiplicity: number }, void, unknown> {
      for (const [data, multiplicity] of sourceGenerator()) {
        yield { data: f(data), multiplicity }
      }
    })()
    
    return {
      next() {
        const result = generator.next()
        if (result.done) {
          return { done: true }
        }
        return { done: false, value: result.value }
      },
      [Symbol.iterator]() {
        return this
      }
    }
  }

  /**
   * Filter out records for which a function f(record) evaluates to False.
   */
  filter(f: (data: T) => boolean): IMultiSet<T> {
    const sourceGenerator = this.#generator
    return new LazyMultiSet(function* () {
      for (const [data, multiplicity] of sourceGenerator()) {
        if (f(data)) {
          const tuple = createTuple(data, multiplicity)
          yield tuple
        }
      }
    })
  }

  /**
   * Negate all multiplicities in the collection.
   */
  negate(): IMultiSet<T> {
    const sourceGenerator = this.#generator
    return new LazyMultiSet(function* () {
      for (const [data, multiplicity] of sourceGenerator()) {
        const tuple = createTuple(data, -multiplicity)
        yield tuple
      }
    })
  }

  /**
   * Concatenate two collections together.
   */
  concat(_other: IMultiSet<T>): IMultiSet<T> {
    const sourceGenerator = this.#generator
    return new LazyMultiSet(function* () {
      yield* sourceGenerator()
      yield* _other
    })
  }

  /**
   * Produce as output a collection that is logically equivalent to the input
   * but which combines identical instances of the same record into one
   * (record, multiplicity) pair.
   */
  consolidate(): IMultiSet<T> {
    // For consolidation, we need to materialize the data
    // since we need to group by key
    const consolidated = new DefaultMap<string | number, number>(() => 0)
    const values = new Map<string, any>()

    let hasString = false
    let hasNumber = false
    let hasOther = false
    
    // First pass to determine data types
    const allData: [T, number][] = []
    for (const [data, multiplicity] of this) {
      allData.push([data, multiplicity])
      if (typeof data === 'string') {
        hasString = true
      } else if (typeof data === 'number') {
        hasNumber = true
      } else {
        hasOther = true
      }
    }

    const requireJson = hasOther || (hasString && hasNumber)

    for (const [data, multiplicity] of allData) {
      const key = requireJson ? hash(data) : (data as string | number)
      if (requireJson && !values.has(key as string)) {
        values.set(key as string, data)
      }
      consolidated.update(key, (count) => count + multiplicity)
    }

    return new LazyMultiSet(function* () {
      for (const [key, multiplicity] of consolidated.entries()) {
        if (multiplicity !== 0) {
          const parsedKey = requireJson ? values.get(key as string) : key
          const tuple = createTuple(parsedKey as T, multiplicity)
          yield tuple
        }
      }
    })
  }

  extend(_other: IMultiSet<T> | MultiSetArray<T>): void {
    // For lazy multisets, extend creates a new generator that yields both
    // Since we can't modify the generator in place, we'll throw an error for now
    // This method is mainly used internally and we may need to reconsider its API
    throw new Error('extend() is not supported on LazyMultiSet. Use concat() instead.')
  }

  /**
   * Get all entries as an array (materializes the lazy evaluation)
   */
  getInner(): MultiSetArray<T> {
    return Array.from(this)
  }

  /**
   * Create a LazyMultiSet from a regular array
   */
  static fromArray<T>(data: MultiSetArray<T>): LazyMultiSet<T> {
    return new LazyMultiSet(function* () {
      yield* data
    })
  }

  /**
   * Create a LazyMultiSet from another IMultiSet
   */
  static from<T>(source: IMultiSet<T>): LazyMultiSet<T> {
    return new LazyMultiSet(function* () {
      yield* source
    })
  }
}

/**
 * Memory-efficient stream adapter that avoids tuple allocations
 */
export class MemoryEfficientStreamAdapter<T> implements MemoryEfficientStream<T> {
  private source: IMultiSet<T>

  constructor(source: IMultiSet<T>) {
    this.source = source
  }

  forEach(handler: (data: T, multiplicity: number) => void): void {
    for (const [data, multiplicity] of this.source) {
      handler(data, multiplicity)
    }
  }

  transform<U>(transformer: (data: T, multiplicity: number) => { data: U; multiplicity: number }): MemoryEfficientStream<U> {
    const source = this.source
    return new class implements MemoryEfficientStream<U> {
      forEach(handler: (data: U, multiplicity: number) => void): void {
        for (const [data, multiplicity] of source) {
          const result = transformer(data, multiplicity)
          handler(result.data, result.multiplicity)
        }
      }

      transform<V>(transformer2: (data: U, multiplicity: number) => { data: V; multiplicity: number }): MemoryEfficientStream<V> {
        return new class implements MemoryEfficientStream<V> {
          forEach(handler: (data: V, multiplicity: number) => void): void {
            for (const [data, multiplicity] of source) {
              const result1 = transformer(data, multiplicity)
              const result2 = transformer2(result1.data, result1.multiplicity)
              handler(result2.data, result2.multiplicity)
            }
          }

          transform<W>(transformer3: (data: V, multiplicity: number) => { data: W; multiplicity: number }): MemoryEfficientStream<W> {
            // For deep nesting, fall back to lazy multiset
            const lazy = new LazyMultiSet(function* () {
              for (const [data, multiplicity] of source) {
                const result1 = transformer(data, multiplicity)
                const result2 = transformer2(result1.data, result1.multiplicity)
                const result3 = transformer3(result2.data, result2.multiplicity)
                yield [result3.data, result3.multiplicity]
              }
            })
            return new MemoryEfficientStreamAdapter(lazy)
          }

          filter(predicate: (data: V, multiplicity: number) => boolean): MemoryEfficientStream<V> {
            const lazy = new LazyMultiSet(function* () {
              for (const [data, multiplicity] of source) {
                const result1 = transformer(data, multiplicity)
                const result2 = transformer2(result1.data, result1.multiplicity)
                if (predicate(result2.data, result2.multiplicity)) {
                  yield [result2.data, result2.multiplicity]
                }
              }
            })
            return new MemoryEfficientStreamAdapter(lazy)
          }

          collect(): IMultiSet<V> {
            const result: [V, number][] = []
            for (const [data, multiplicity] of source) {
              const result1 = transformer(data, multiplicity)
              const result2 = transformer2(result1.data, result1.multiplicity)
              result.push([result2.data, result2.multiplicity])
            }
            return new MultiSet(result)
          }
        }()
      }

      filter(predicate: (data: U, multiplicity: number) => boolean): MemoryEfficientStream<U> {
        const lazy = new LazyMultiSet(function* () {
          for (const [data, multiplicity] of source) {
            const result = transformer(data, multiplicity)
            if (predicate(result.data, result.multiplicity)) {
              yield [result.data, result.multiplicity]
            }
          }
        })
        return new MemoryEfficientStreamAdapter(lazy)
      }

      collect(): IMultiSet<U> {
        const result: [U, number][] = []
        for (const [data, multiplicity] of source) {
          const transformed = transformer(data, multiplicity)
          result.push([transformed.data, transformed.multiplicity])
        }
        return new MultiSet(result)
      }
    }()
  }

  filter(predicate: (data: T, multiplicity: number) => boolean): MemoryEfficientStream<T> {
    const source = this.source
    return new class implements MemoryEfficientStream<T> {
      forEach(handler: (data: T, multiplicity: number) => void): void {
        for (const [data, multiplicity] of source) {
          if (predicate(data, multiplicity)) {
            handler(data, multiplicity)
          }
        }
      }

      transform<U>(transformer: (data: T, multiplicity: number) => { data: U; multiplicity: number }): MemoryEfficientStream<U> {
        const lazy = new LazyMultiSet(function* () {
          for (const [data, multiplicity] of source) {
            if (predicate(data, multiplicity)) {
              const result = transformer(data, multiplicity)
              yield [result.data, result.multiplicity]
            }
          }
        })
        return new MemoryEfficientStreamAdapter(lazy)
      }

      filter(predicate2: (data: T, multiplicity: number) => boolean): MemoryEfficientStream<T> {
        const lazy = new LazyMultiSet(function* () {
          for (const [data, multiplicity] of source) {
            if (predicate(data, multiplicity) && predicate2(data, multiplicity)) {
              yield [data, multiplicity]
            }
          }
        })
        return new MemoryEfficientStreamAdapter(lazy)
      }

      collect(): IMultiSet<T> {
        const result: [T, number][] = []
        for (const [data, multiplicity] of source) {
          if (predicate(data, multiplicity)) {
            result.push([data, multiplicity])
          }
        }
        return new MultiSet(result)
      }
    }()
  }

  collect(): IMultiSet<T> {
    return this.source
  }
}

/**
 * Convert a MultiSet to a memory-efficient stream
 */
export function toMemoryEfficientStream<T>(multiset: IMultiSet<T>): MemoryEfficientStream<T> {
  return new MemoryEfficientStreamAdapter(multiset)
}
