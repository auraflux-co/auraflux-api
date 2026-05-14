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

// ── The Hero — AF Angular Monogram ────────────────────────────────────────────
export function HeroMonogram({ size = 24, ...props }: IconProps) {
  return (
    <svg
      width={size} height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* A — triangle with crossbar */}
      <polygon points="4,34 13,8 17,8 20,18" fill="currentColor" />
      <polygon points="20,18 23,8 27,8 36,34 31,34 20,18" fill="currentColor" />
      <rect x="9" y="22" width="14" height="4" rx="1" fill="currentColor" />
      {/* F — vertical bar + two horizontal arms */}
      <rect x="23" y="8" width="4" height="26" rx="1" fill="currentColor" />
      <rect x="27" y="8" width="9" height="4" rx="1" fill="currentColor" />
      <rect x="27" y="17" width="7" height="4" rx="1" fill="currentColor" />
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
