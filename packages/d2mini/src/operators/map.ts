import { IStreamBuilder } from '../types.js'
import {
  DifferenceStreamReader,
  DifferenceStreamWriter,
  LinearUnaryOperator,
} from '../graph.js'
import { StreamBuilder } from '../d2.js'
import { LazyMultiSet, toMemoryEfficientStream } from '../multiset.js'
import { createTuple } from '../utils.js'

/**
 * Memory-efficient map operator that avoids tuple allocations
 */
export class MemoryEfficientMapOperator<Tin, Tout> extends LinearUnaryOperator<Tin | Tout> {
  #f: (data: Tin) => Tout

  constructor(
    id: number,
    inputA: DifferenceStreamReader<Tin>,
    output: DifferenceStreamWriter<Tout>,
    f: (data: Tin) => Tout,
  ) {
    super(id, inputA, output)
    this.#f = f
  }

  inner(collection: any): any {
    // Use memory-efficient stream processing
    const stream = toMemoryEfficientStream(collection)
    const transformed = stream.transform((data, multiplicity) => ({
      data: this.#f(data as Tin),
      multiplicity
    }))
    
    // Only materialize when sending to output
    const result: [Tout, number][] = []
    transformed.forEach((data, multiplicity) => {
      const tuple = createTuple(data, multiplicity)
      result.push(tuple)
    })
    
    return new LazyMultiSet(function* () {
      yield* result
    })
  }
}

/**
 * Memory-efficient map operation that avoids tuple allocations
 */
export function mapMemoryEfficient<T, U>(f: (data: T) => U) {
  return (stream: IStreamBuilder<T>): IStreamBuilder<U> => {
    const output = new StreamBuilder<U>(
      stream.graph,
      new DifferenceStreamWriter<U>(),
    )
    const operator = new MemoryEfficientMapOperator<T, U>(
      stream.graph.getNextOperatorId(),
      stream.connectReader(),
      output.writer,
      f,
    )
    stream.graph.addOperator(operator)
    stream.graph.addStream(output.connectReader())
    return output
  }
}
