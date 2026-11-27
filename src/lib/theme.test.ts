import assert from 'node:assert/strict'
import { isTheme, resolveTheme, toggleTheme } from './theme.ts'

assert.ok(isTheme('light') && isTheme('dark'), 'light and dark are themes')
assert.ok(!isTheme('auto') && !isTheme(null), 'unknown values are not themes')
assert.equal(toggleTheme('light'), 'dark', 'light toggles to dark')
assert.equal(toggleTheme('dark'), 'light', 'dark toggles to light')
assert.equal(resolveTheme('light'), 'light', 'stored light wins')
assert.equal(resolveTheme('dark'), 'dark', 'stored dark wins')

console.log('theme tests passed')
