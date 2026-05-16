import '@testing-library/jest-dom'

// Mock DOM APIs that Monaco expects but jsdom doesn't implement
document.queryCommandSupported = () => false;
(window as any).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
});
