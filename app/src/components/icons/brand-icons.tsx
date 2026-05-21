/**
 * AuraFlux Brand Icon Family
 *
 * Four icons from the logo family brief:
 *   HeroMonogram   — AF angular monogram. Primary brand mark (login, sidebar).
 *   EngineHexagon  — Interlocking hexagon. Backend / admin processing.
 *   SparkAnvil     — Action anvil with spark. Creative Action / job wizard.
 *   FlowNetwork    — Network node diamond. Distribution / scheduling.
 *
 * All icons accept standard SVG props + an optional `size` shorthand.
 * Default size: 24. Colors use currentColor so they inherit from parent text class.
 */

import { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

// ── The Hero — AF Monogram (bold block A + F, crisp at 20–32px) ─────────────
export function HeroMonogram({ size = 24, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      {...props}
    >
      {/* A — thick legs, clear crossbar, open counter via evenodd */}
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M0 22 L5.5 1 L11 22 H8 L7 15.5 H4 L3 22 Z M5 12.5 H7 L5.5 7.5 Z"
      />
      {/* F — full top bar, shorter mid bar, clean stem */}
      <path
        fill="currentColor"
        d="M13 1 H24 V5.5 H17.5 V10.5 H23 V15 H17.5 V23 H13 Z"
      />
    </svg>
  );
}

// ── Credit token — stacked coins for credits badge (not profile avatar) ───────
export function CreditToken({ size = 24, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      {...props}
    >
      <ellipse cx="12" cy="15.5" rx="7.5" ry="2.5" fill="currentColor" opacity="0.35" />
      <ellipse cx="12" cy="11.5" rx="7.5" ry="2.5" fill="currentColor" opacity="0.6" />
      <ellipse cx="12" cy="7.5" rx="7.5" ry="2.5" fill="currentColor" />
      <path
        d="M12 5.5v4M10 7.5h4"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.85"
      />
    </svg>
  );
}

// ── The Engine — Interlocking Hexagon ─────────────────────────────────────────
export function EngineHexagon({ size = 24, ...props }: IconProps) {
  // Outer hexagon (copper stroke) + inner hexagon rotated 30° (teal fill)
  const outer = '20,2 34.64,11 34.64,29 20,38 5.36,29 5.36,11';
  const inner = '20,8 29.85,13.5 29.85,26.5 20,32 10.15,26.5 10.15,13.5';
  return (
    <svg
      width={size} height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <polygon points={outer} stroke="currentColor" strokeWidth="2" fill="none" opacity="0.7" />
      <polygon points={inner} fill="currentColor" opacity="0.3" />
      <polygon points={inner} stroke="currentColor" strokeWidth="1.5" fill="none" />
      {/* Centre dot */}
      <circle cx="20" cy="20" r="3" fill="currentColor" />
    </svg>
  );
}

// ── The Spark — Action Anvil ───────────────────────────────────────────────────
export function SparkAnvil({ size = 24, ...props }: IconProps) {
  return (
    <svg
      width={size} height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* Spark rays */}
      <line x1="20" y1="2"  x2="20" y2="8"  stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="27" y1="4"  x2="24" y2="9"  stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="13" y1="4"  x2="16" y2="9"  stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="31" y1="8"  x2="27" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="9"  y1="8"  x2="13" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* Spark centre glow */}
      <circle cx="20" cy="12" r="2.5" fill="currentColor" />
      {/* Anvil body — top flat surface */}
      <rect x="8" y="16" width="24" height="6" rx="2" fill="currentColor" />
      {/* Anvil horn (left) */}
      <path d="M8 16 Q2 19 6 22 L8 22 Z" fill="currentColor" />
      {/* Anvil base */}
      <rect x="13" y="22" width="14" height="3" fill="currentColor" />
      <rect x="10" y="25" width="20" height="4" rx="1.5" fill="currentColor" />
    </svg>
  );
}

// ── The Flow — Network Node Diamond ───────────────────────────────────────────
export function FlowNetwork({ size = 24, ...props }: IconProps) {
  // Outer octagon / diamond outline + inner network of connected nodes
  const octagon = '20,2 32,8 38,20 32,32 20,38 8,32 2,20 8,8';
  // Node positions: centre + 6 outer
  const nodes = [
    [20, 20],   // centre
    [20, 9],    // top
    [29, 14.5], // top-right
    [29, 25.5], // bottom-right
    [20, 31],   // bottom
    [11, 25.5], // bottom-left
    [11, 14.5], // top-left
  ];
  // Edges: centre to each outer, plus ring
  const edges = [
    [0,1],[0,2],[0,3],[0,4],[0,5],[0,6],
    [1,2],[2,3],[3,4],[4,5],[5,6],[6,1],
  ];
  return (
    <svg
      width={size} height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <polygon points={octagon} stroke="currentColor" strokeWidth="1.5" fill="none" opacity="0.5" />
      {edges.map(([a, b], i) => (
        <line
          key={i}
          x1={nodes[a][0]} y1={nodes[a][1]}
          x2={nodes[b][0]} y2={nodes[b][1]}
          stroke="currentColor" strokeWidth="1" opacity="0.5"
        />
      ))}
      {nodes.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r={i === 0 ? 3 : 2} fill="currentColor" />
      ))}
    </svg>
  );
}
