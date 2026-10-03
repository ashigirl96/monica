type CleanupFn = () => void;

export class EventCleanupManager {
  private cleanups: CleanupFn[] = [];

  addEventListener<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (ev: HTMLElementEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener, options);
    this.cleanups.push(() => {
      target.removeEventListener(type, listener, options as boolean | EventListenerOptions);
    });
  }

  add(cleanup: CleanupFn): void {
    this.cleanups.push(cleanup);
  }

  disposeAll(): void {
    for (const fn of this.cleanups) fn();
    this.cleanups = [];
  }
}
