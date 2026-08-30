declare module 'jsdom' {
  interface JSDOMOptions {
    readonly beforeParse?: ((window: Window) => void) | undefined;
    readonly pretendToBeVisual?: boolean | undefined;
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Window;
  }
}
