/**
 * Event handler function type
 */
export type EventHandler<T = unknown> = (event: T) => void;

/**
 * Lightweight EventEmitter implementation for browser environments.
 * Provides type-safe event handling without external dependencies.
 *
 * @example
 * ```typescript
 * interface MyEvents {
 *   data: { value: number };
 *   error: Error;
 * }
 *
 * class MyClass extends EventEmitter<MyEvents> {
 *   doSomething() {
 *     this.emit('data', { value: 42 });
 *   }
 * }
 *
 * const instance = new MyClass();
 * instance.on('data', (event) => console.log(event.value));
 * ```
 */
export class EventEmitter<T extends { [K in keyof T]: unknown }> {
  private listeners = new Map<keyof T, Set<EventHandler<any>>>();

  /**
   * Register an event handler for the specified event.
   *
   * @param event - The event name to listen for
   * @param handler - The handler function to call when the event is emitted
   * @returns this instance for chaining
   */
  on<K extends keyof T>(event: K, handler: EventHandler<T[K]>): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return this;
  }

  /**
   * Remove an event handler for the specified event.
   *
   * @param event - The event name
   * @param handler - The handler function to remove
   * @returns this instance for chaining
   */
  off<K extends keyof T>(event: K, handler: EventHandler<T[K]>): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  /**
   * Emit an event to all registered handlers.
   *
   * @param event - The event name to emit
   * @param data - The event data to pass to handlers
   * @returns true if there were listeners, false otherwise
   */
  protected emit<K extends keyof T>(event: K, data: T[K]): boolean {
    const handlers = this.listeners.get(event);
    if (!handlers || handlers.size === 0) {
      return false;
    }
    handlers.forEach((handler) => handler(data));
    return true;
  }

  /**
   * Remove all listeners for a specific event, or all events if no event is specified.
   *
   * @param event - Optional event name. If omitted, all listeners are removed.
   * @returns this instance for chaining
   */
  removeAllListeners(event?: keyof T): this {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
    return this;
  }
}
