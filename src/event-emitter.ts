/**
 * イベントハンドラー関数の型
 */
export type EventHandler<T = unknown> = (event: T) => void;

/**
 * ブラウザ環境向けの軽量なEventEmitter実装
 * 外部依存なしで型安全なイベントハンドリングを提供する
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
  /** イベント名からハンドラーのセットへのマップ */
  private listeners = new Map<keyof T, Set<EventHandler<any>>>();

  /**
   * 指定されたイベントに対してハンドラーを登録する
   *
   * @param event リッスンするイベント名
   * @param handler イベント発生時に呼び出されるハンドラー関数
   * @returns メソッドチェーン用のthisインスタンス
   */
  on<K extends keyof T>(event: K, handler: EventHandler<T[K]>): this {
    // イベント名に対応するセットがなければ新規作成
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    // ハンドラーをセットに追加
    this.listeners.get(event)!.add(handler);
    return this;
  }

  /**
   * 指定されたイベントからハンドラーを削除する
   *
   * @param event イベント名
   * @param handler 削除するハンドラー関数
   * @returns メソッドチェーン用のthisインスタンス
   */
  off<K extends keyof T>(event: K, handler: EventHandler<T[K]>): this {
    // セットからハンドラーを削除
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  /**
   * 登録されたすべてのハンドラーにイベントを発行する
   *
   * @param event 発行するイベント名
   * @param data ハンドラーに渡すイベントデータ
   * @returns リスナーがあればtrue、なければfalse
   */
  protected emit<K extends keyof T>(event: K, data: T[K]): boolean {
    // イベントに対応するハンドラーを取得
    const handlers = this.listeners.get(event);
    // ハンドラーがない場合はfalseを返す
    if (!handlers || handlers.size === 0) {
      return false;
    }
    // 各ハンドラーを呼び出す
    handlers.forEach((handler) => handler(data));
    return true;
  }

  /**
   * 指定されたイベント、またはすべてのイベントのリスナーを削除する
   *
   * @param event イベント名（省略時はすべてのリスナーを削除）
   * @returns メソッドチェーン用のthisインスタンス
   */
  removeAllListeners(event?: keyof T): this {
    if (event) {
      // 特定のイベントのリスナーを削除
      this.listeners.delete(event);
    } else {
      // すべてのリスナーをクリア
      this.listeners.clear();
    }
    return this;
  }
}
