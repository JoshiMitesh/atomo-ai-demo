# Atomo Forge Dashboard — Phase 1

Enterprise Overview dashboard for Atomo Forge edge gateways. Built with React 18, Vite, and TypeScript. All data is static mock — no backend calls in this phase.

## Setup

```bash
cd dashboard
npm install
npm run dev
```

Open **http://localhost:5173**

### Production build

```bash
npm run build
npm run preview
```

## Tech stack

| Layer | Choice |
|-------|--------|
| Framework | React 18 (Strict Mode) |
| Build | Vite 6 + TypeScript (strict) |
| Icons | `lucide-react` only |
| Styling | CSS Modules + `tokens.css` custom properties |
| Fonts | Inter + DM Mono (Google Fonts) |

No Tailwind, no shadcn, no MUI, no Bootstrap.

## Project structure

```
dashboard/
├── index.html                  # Fonts + root mount
├── src/
│   ├── main.tsx                # Entry point
│   ├── App.tsx                 # App shell + page routing (Phase 2)
│   ├── styles/
│   │   ├── tokens.css          # Light/dark design tokens
│   │   └── global.css          # Reset, animations, utilities
│   ├── mock/
│   │   └── systemData.ts       # Full mock dataset (swap for API in Phase 2)
│   ├── hooks/
│   │   ├── useTheme.ts         # Theme toggle → localStorage atomo_theme
│   │   ├── useUptime.ts        # Live uptime counter (1s interval)
│   │   ├── useCountUp.ts       # Animated numeric values on mount
│   │   ├── useLiveClock.ts     # Navbar HH:MM:SS clock
│   │   ├── useSidebarCollapse.ts # Sidebar state → atomo_sidebar_collapsed
│   │   └── useMediaQuery.ts    # Responsive breakpoint detection
│   ├── components/
│   │   ├── AppShell/           # Layout wrapper (Navbar + Sidebar + main)
│   │   ├── Navbar/             # Top bar, clock, theme toggle
│   │   ├── Sidebar/            # Collapsible nav (always dark navy)
│   │   ├── Logo/               # AF brand mark (#5B5BD6)
│   │   ├── Toast/              # Custom toast notifications
│   │   ├── StatCard/           # Summary metric cards
│   │   ├── GaugeMeter/         # CPU/NPU/RAM/Storage bars
│   │   ├── StatusBadge/        # Connected, Master, Valid, etc.
│   │   ├── InfoCard/           # Label/value detail cards
│   │   ├── SectionHeader/      # Section titles
│   │   └── QuickActionButton/  # Quick action tiles
│   └── pages/
│       └── OverviewPage/       # All 7 Overview sections
└── README.md
```

## Overview page — 7 sections

1. **Summary** — Total/Active/Offline cameras, AI models running, Alerts today, Critical alerts
2. **Device Identity & Sync** — Device role, Master/Slave status, Atomic Centre sync
3. **Resource Usage** — CPU, NPU, RAM, Storage gauges
4. **Network** — Interface, download/upload Mbps, device IP
5. **Device Health** — Temperature, uptime (live), power status
6. **Firmware & License** — Version info, license edition and expiry
7. **Quick Actions** — Add camera, toggle AI, sync, logs, reboot (toast feedback only)

## Swapping mock data for real API (Phase 2)

1. Create `src/api/dashboard.ts` with fetch helpers:

```typescript
export async function fetchOverview(): Promise<SystemOverview> {
  const res = await fetch('/api/dashboard/overview');
  if (!res.ok) throw new Error('Failed to load overview');
  return res.json();
}
```

2. In `OverviewPage.tsx`, replace the static import:

```typescript
// Before (Phase 1)
import { systemOverview } from '../../mock/systemData';
const data = systemOverview;

// After (Phase 2)
const [data, setData] = useState<SystemOverview | null>(null);
useEffect(() => {
  fetchOverview().then(setData);
}, []);
```

3. Keep `SystemOverview` type in `systemData.ts` (move types to `src/types/` if preferred).
4. Add polling with `setInterval` for live metrics (CPU, network, uptime base).

## Adding new sidebar nav items

Edit `navItems` in `src/components/Navbar/Navbar.tsx`:

```typescript
{ id: 'cameras', label: 'Cameras', icon: Camera, active: false },
```

Then in Phase 2:
1. Install `react-router-dom`
2. Add routes in `App.tsx`
3. Set `active: true` based on current route
4. Replace `href="#"` preventDefault with `<NavLink to="/cameras">`

Placeholder pages already have `TODO Phase 2` comments in Sidebar and App.tsx.

## Theme & persistence

| Key | Storage | Default |
|-----|---------|---------|
| `atomo_theme` | `localStorage` | `dark` |
| `atomo_sidebar_collapsed` | `localStorage` | `false` (collapsed on 1024–1279px) |

Toggle via Sun/Moon icon in navbar. Theme sets `data-theme="light|dark"` on `<html>`.

## Responsive breakpoints

| Breakpoint | Layout |
|------------|--------|
| ≥ 1280px | Full sidebar, 4-column stat grid |
| 1024–1279px | Sidebar collapsed, 2-column stat grid |
| 768–1023px | Sidebar drawer (hamburger), 2-column grid |
| < 768px | Mobile drawer, 1-column grid (basic) |

## Phase 2 TODO markers

Search the codebase for `TODO Phase 2` to find extension points:
- React Router pages (Cameras, Live View, AI Models, Alerts, Network, Settings)
- Quick action API wiring
- Real-time metric polling
- Sidebar navigation routing
