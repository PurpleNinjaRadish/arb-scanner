import { render, screen } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        hosts: [], local: 'offline', aws: 'offline', servers: [], fees: {},
        status: { unreadCount: 0 }, alerts: [], watchAccounts: [],
      })),
    })
  );
});

afterEach(() => {
  jest.resetAllMocks();
});

test('renders Arb Scanner v3 workspaces including Alerts & Holdings', async () => {
  render(<App />);
  expect(await screen.findByRole('heading', { name: /ARB SCANNER v3/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Scanner/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Alerts & Mobile/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Holdings & Txns/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Hummingbot/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Paper Lab/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Projections/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Servers/i })).toBeInTheDocument();
});
