import type { ReactNode } from 'react';

export const metadata = {
  title: 'ATOMO Control Center',
  description: 'Distributed Master-Slave Edge AI Platform Control Plane',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'ui-sans-serif, system-ui', margin: 0, background: '#0b1220', color: '#e5e7eb' }}>
        <div style={{ padding: 20, borderBottom: '1px solid #1f2937' }}>
          <strong>ATOMO</strong> Control Center
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </body>
    </html>
  );
}

