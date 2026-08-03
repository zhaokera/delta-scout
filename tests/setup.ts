import "@testing-library/jest-dom/vitest";

// Ant Design 6 emits CSS variable expressions that jsdom 30 cannot always
// resolve while Testing Library checks accessibility. Real browsers resolve
// them correctly, so keep the native result and only fall back to inline
// styles when jsdom's font-size parser throws.
if (typeof window !== "undefined") {
  const nativeGetComputedStyle = window.getComputedStyle.bind(window);
  Object.defineProperty(window, "getComputedStyle", {
    configurable: true,
    value(element: Element, pseudoElement?: string | null) {
      try {
        return nativeGetComputedStyle(element, pseudoElement);
      } catch {
        return (element as HTMLElement).style;
      }
    }
  });
}
