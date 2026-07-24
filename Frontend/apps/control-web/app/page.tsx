async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export default async function HomePage() {
  const devices = await fetchJson<any[]>(process.env.CONTROL_API_URL || 'http://localhost:4000/v1/devices');

  return (
    <main>
      <h1 style={{ marginTop: 0 }}>Fleet Overview</h1>
      <p style={{ color: '#9ca3af' }}>
        This is the initial Master dashboard scaffold. Next: discovery approval, alerts, topology, health.
      </p>

      <div style={{ background: '#0f172a', border: '1px solid #1f2937', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: 12, borderBottom: '1px solid #1f2937', fontWeight: 600 }}>Devices</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#9ca3af', fontSize: 12 }}>
              <th style={{ padding: 12, borderBottom: '1px solid #1f2937' }}>Name</th>
              <th style={{ padding: 12, borderBottom: '1px solid #1f2937' }}>Serial</th>
              <th style={{ padding: 12, borderBottom: '1px solid #1f2937' }}>Role</th>
              <th style={{ padding: 12, borderBottom: '1px solid #1f2937' }}>Status</th>
              <th style={{ padding: 12, borderBottom: '1px solid #1f2937' }}>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td style={{ padding: 12, borderBottom: '1px solid #1f2937' }}>{d.deviceName}</td>
                <td style={{ padding: 12, borderBottom: '1px solid #1f2937', fontFamily: 'ui-monospace' }}>{d.serialNumber}</td>
                <td style={{ padding: 12, borderBottom: '1px solid #1f2937' }}>{d.role}</td>
                <td style={{ padding: 12, borderBottom: '1px solid #1f2937' }}>{d.status}</td>
                <td style={{ padding: 12, borderBottom: '1px solid #1f2937', fontFamily: 'ui-monospace' }}>
                  {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

