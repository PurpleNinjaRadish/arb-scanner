import { render, screen, fireEvent } from '@testing-library/react';
import CrossCheckReport, { OverrideConfirm, overrideReady } from './CrossCheckReport';
import fixtures from './__fixtures__/crosscheck.json';

test('renders a passing cross-check with both calculations', () => {
  render(<CrossCheckReport check={fixtures.pass} />);
  expect(screen.getByText(/VERIFIED/)).toBeInTheDocument();
  expect(screen.getByText(/1 · Per trade/)).toBeInTheDocument();
  expect(screen.getByText(/2 · Monthly/)).toBeInTheDocument();
  expect(screen.getAllByText('PROFITABLE').length).toBe(2);
});

test('renders a failing cross-check with blockers and a missing book', () => {
  render(<CrossCheckReport check={fixtures.fail} compact />);
  expect(screen.getByText(/BLOCKED — price data failed/)).toBeInTheDocument();
  expect(screen.getAllByText(/HTTP 503/).length).toBeGreaterThan(0);
});

test('live override requires the checkbox and the exact phrase', () => {
  expect(overrideReady({ live: false, phrase: null, confirmed: true, typed: '' })).toBe(true);
  expect(overrideReady({ live: true, phrase: 'SOL-USD LIVE', confirmed: true, typed: 'sol-usd' })).toBe(false);
  expect(overrideReady({ live: true, phrase: 'SOL-USD LIVE', confirmed: false, typed: 'SOL-USD LIVE' })).toBe(false);
  expect(overrideReady({ live: true, phrase: 'SOL-USD LIVE', confirmed: true, typed: ' sol-usd live ' })).toBe(true);
  const setConfirmed = jest.fn();
  render(<OverrideConfirm live phrase="SOL-USD LIVE" confirmed={false} setConfirmed={setConfirmed} typed="" setTyped={() => {}} />);
  fireEvent.click(screen.getByRole('checkbox'));
  expect(setConfirmed).toHaveBeenCalledWith(true);
});
