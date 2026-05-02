import { describe, it, expect } from 'vitest'
import { getModeSystemPrompt, MODE_PROMPTS, type AIMode } from '../aiModes'

const MODES: AIMode[] = ['chat', 'operator', 'troubleshoot', 'copilot']
const SENTINEL = '## Mode: SENTINEL\n\nThis is a test override.'

describe('getModeSystemPrompt', () => {
  for (const mode of MODES) {
    it(`uses default ${mode} prompt when no overrides passed`, () => {
      const out = getModeSystemPrompt(mode, true)
      expect(out).toContain(MODE_PROMPTS[mode])
    })

    it(`uses default ${mode} prompt when overrides for that mode is empty/absent`, () => {
      const out = getModeSystemPrompt(mode, true, {})
      expect(out).toContain(MODE_PROMPTS[mode])
    })

    it(`uses default ${mode} prompt when override value is empty string`, () => {
      const out = getModeSystemPrompt(mode, true, { [mode]: '' })
      expect(out).toContain(MODE_PROMPTS[mode])
    })

    it(`substitutes override for ${mode} when override is non-empty`, () => {
      const out = getModeSystemPrompt(mode, true, { [mode]: SENTINEL })
      expect(out).toContain(SENTINEL)
      expect(out).not.toContain(MODE_PROMPTS[mode])
    })
  }

  it('always includes NETSTACKS_IDENTITY (with or without override)', () => {
    const withDefault = getModeSystemPrompt('operator', false)
    const withOverride = getModeSystemPrompt('operator', false, { operator: SENTINEL })
    expect(withDefault).toContain('NetStacks Platform Knowledge')
    expect(withOverride).toContain('NetStacks Platform Knowledge')
  })

  it('appends enterprise addendum when isEnterprise=true (non-chat modes)', () => {
    const out = getModeSystemPrompt('operator', true)
    expect(out).toContain('Enterprise Features Available')
  })

  it('appends standalone addendum when isEnterprise=false (non-chat modes)', () => {
    const out = getModeSystemPrompt('operator', false)
    expect(out).toContain('enterprise-only features')
  })

  it('chat mode never gets an addendum', () => {
    const ent = getModeSystemPrompt('chat', true)
    const std = getModeSystemPrompt('chat', false)
    expect(ent).not.toContain('Enterprise Features Available')
    expect(std).not.toContain('enterprise-only features')
  })

  it('override for one mode does not affect another mode', () => {
    const out = getModeSystemPrompt('chat', true, { operator: SENTINEL })
    expect(out).not.toContain(SENTINEL)
    expect(out).toContain(MODE_PROMPTS.chat)
  })
})

describe('MODE_PROMPTS export', () => {
  it('exports all four modes', () => {
    for (const mode of MODES) {
      expect(MODE_PROMPTS[mode]).toBeDefined()
      expect(typeof MODE_PROMPTS[mode]).toBe('string')
      expect(MODE_PROMPTS[mode].length).toBeGreaterThan(0)
    }
  })
})
