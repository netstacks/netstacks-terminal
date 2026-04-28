import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import App from './App'

describe('App', () => {
  it('renders without crashing', () => {
    // This is a smoke test to verify the test infrastructure works
    // More comprehensive tests can be added later
    const { container } = render(<App />)
    expect(container).toBeInTheDocument()
  })

  it('renders a non-empty component', () => {
    const { container } = render(<App />)
    // Verify the component renders something (not empty)
    expect(container.firstChild).toBeTruthy()
  })
})
