import { MultiSet } from '../src/multiset.js'
import { expect } from 'vitest'

/**
 * Materialize a result set from diff messages
 * Takes an array of messages and consolidates them into a final result set
 */
export function materializeResults<T>(messages: [T, number][]): Map<string, T> {
  const multiSet = new MultiSet(messages)
  const consolidated = multiSet.consolidate()
  const result = new Map<string, T>()
  
  for (const [item, multiplicity] of consolidated.getInner()) {
    if (multiplicity > 0) {
      // Use JSON.stringify for content-based key comparison
      const key = JSON.stringify(item)
      result.set(key, item)
    }
  }
  
  return result
}

/**
 * Convert a Map back to a sorted array for comparison
 */
export function mapToSortedArray<T>(map: Map<string, T>): T[] {
  return Array.from(map.values()).sort((a, b) => {
    // Sort by JSON string representation for consistent ordering
    return JSON.stringify(a).localeCompare(JSON.stringify(b))
  })
}

/**
 * Create expected result set as a Map
 */
export function createExpectedResults<T>(items: T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) {
    const key = JSON.stringify(item)
    map.set(key, item)
  }
  return map
}

/**
 * Test helper that tracks messages and materializes results
 */
export interface TestResult<T> {
  messages: [T, number][]
  messageCount: number
  materializedResults: Map<string, T>
  sortedResults: T[]
}

export class MessageTracker<T> {
  private messages: [T, number][] = []
  
  addMessage(message: MultiSet<T>) {
    this.messages.push(...message.getInner())
  }
  
  getResult(): TestResult<T> {
    const materializedResults = materializeResults(this.messages)
    const sortedResults = mapToSortedArray(materializedResults)
    
    return {
      messages: this.messages,
      messageCount: this.messages.length,
      materializedResults,
      sortedResults
    }
  }
  
  reset() {
    this.messages = []
  }
}

/**
 * Assert that results match expected, with message count logging
 */
export function assertResults<T>(
  testName: string,
  actual: TestResult<T>,
  expected: T[],
  maxExpectedMessages?: number
) {
  const expectedMap = createExpectedResults(expected)
  const expectedSorted = mapToSortedArray(expectedMap)
  
  console.log(`${testName}: ${actual.messageCount} messages, ${actual.sortedResults.length} final results`)
  
  // Check that materialized results match expected
  expect(actual.sortedResults).toEqual(expectedSorted)
  
  // Check message count constraints if provided
  if (maxExpectedMessages !== undefined) {
    expect(actual.messageCount).toBeLessThanOrEqual(maxExpectedMessages)
  }
  
  // Log for debugging
  if (actual.messageCount > expected.length * 2) {
    console.warn(`⚠️  ${testName}: High message count (${actual.messageCount} messages for ${expected.length} expected results)`)
  }
}

/**
 * Extract unique keys from messages to verify incremental behavior
 */
export function extractMessageKeys<K, V>(messages: [[K, V], number][]): Set<K> {
  const keys = new Set<K>()
  for (const [[key, _value], _multiplicity] of messages) {
    keys.add(key)
  }
  return keys
}

/**
 * Assert that only specific keys appear in messages (for incremental processing verification)
 */
export function assertOnlyKeysAffected<K, V>(
  testName: string,
  messages: [[K, V], number][], 
  expectedKeys: K[]
) {
  const actualKeys = extractMessageKeys(messages)
  const expectedKeySet = new Set(expectedKeys)
  
  // Check that all actual keys are expected
  Array.from(actualKeys).forEach(key => {
    if (!expectedKeySet.has(key)) {
      throw new Error(`${testName}: Unexpected key ${key} in messages`)
    }
  })
  
  console.log(`${testName}: ✅ Only affected keys (${Array.from(actualKeys).join(', ')}) produced messages`)
}