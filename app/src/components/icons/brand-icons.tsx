/**
 * Platform social icons — YouTube, TikTok, Instagram, Twitch, Kick
 * These use official brand colours and are used in the social connect page
 * and platform picker. Colors are hardcoded (brand marks, not theme tokens).
 */

export function YouTubeIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <rect width="24" height="24" rx="5" fill="#FF0000" />
      <path d="M19.6 8.2a2 2 0 0 0-1.4-1.4C16.9 6.5 12 6.5 12 6.5s-4.9 0-6.2.3A2 2 0 0 0 4.4 8.2C4.1 9.5 4.1 12 4.1 12s0 2.5.3 3.8a2 2 0 0 0 1.4 1.4c1.3.3 6.2.3 6.2.3s4.9 0 6.2-.3a2 2 0 0 0 1.4-1.4c.3-1.3.3-3.8.3-3.8s0-2.5-.3-3.8z" fill="white" />
      <path d="M10.2 14.6V9.4l4.5 2.6-4.5 2.6z" fill="#FF0000" />
    </svg>
  );
}

export function TikTokIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <rect width="24" height="24" rx="5" fill="#010101" />
      <path d="M16.6 5h-2.3v9.3a2.3 2.3 0 1 1-2.3-2.3c.2 0 .4 0 .6.1V9.6a4.6 4.6 0 1 0 4.3 4.7V9.1c.8.6 1.8.9 2.8.9V7.8c-1.6 0-3.1-1.3-3.1-2.8z" fill="white" />
      <path d="M19.4 9.4v2.4c-1 0-2-.3-2.8-.9v4.2a4.6 4.6 0 1 1-4.3-4.7v2.5c-.2-.1-.4-.1-.6-.1a2.3 2.3 0 1 0 2.3 2.3V5h2.3c0 1.5 1.5 2.8 3.1 2.8v1.6z" fill="#EE1D52" />
      <path d="M13.7 9.5v2.5c-.2-.1-.4-.1-.6-.1a2.3 2.3 0 0 0 0 4.6 2.3 2.3 0 0 0 2.3-2.3V5h2.3c0 1.5 1.5 2.8 3.1 2.8v2.4c-1 0-2-.3-2.8-.9v4.2a4.6 4.6 0 1 1-5-4.6v.6z" fill="#69C9D0" />
    </svg>
  );
}

export function InstagramIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <defs>
        <radialGradient id="ig-grad" cx="30%" cy="107%" r="150%">
          <stop offset="0%" stopColor="#fdf497" />
          <stop offset="5%" stopColor="#fdf497" />
          <stop offset="45%" stopColor="#fd5949" />
          <stop offset="60%" stopColor="#d6249f" />
          <stop offset="90%" stopColor="#285AEB" />
        </radialGradient>
      </defs>
      <rect width="24" height="24" rx="5" fill="url(#ig-grad)" />
      <rect x="6.5" y="6.5" width="11" height="11" rx="3" stroke="white" strokeWidth="1.5" fill="none" />
      <circle cx="12" cy="12" r="3" stroke="white" strokeWidth="1.5" fill="none" />
      <circle cx="16.2" cy="7.8" r="0.8" fill="white" />
    </svg>
  );
}

export function TwitchIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <rect width="24" height="24" rx="5" fill="#9146FF" />
      <path d="M6 4l-2 3v12h4v3l3-3h3l5-5V4H6zm10.5 9l-2.5 2.5H11l-2 2V15.5H6V5.5h10.5v7.5z" fill="white" />
      <rect x="14" y="8" width="1.5" height="4" rx="0.5" fill="#9146FF" />
      <rect x="10.5" y="8" width="1.5" height="4" rx="0.5" fill="#9146FF" />
    </svg>
  );
}

export function KickIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <rect width="24" height="24" rx="5" fill="#53FC18" />
      <path d="M7 5h3v5.5l3.5-5.5H17l-4.5 6.5L17 19h-3.5L10 13.5V19H7V5z" fill="black" />
    </svg>
  );
}

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

// ── The Hero — AF Monogram ────────────────────────────────────────────────────
//
//  Matches the brand mark: bold italic AF where the A's peak merges with the F.
//  Structure:
//    1. Left thick diagonal  — primary stroke of the A
//    2. F top bar            — full-width horizontal at the A peak
//    3. A right leg          — short diagonal connecting the two F bars
//    4. F lower bar          — horizontal bar that also reads as the A crossbar
//
//  viewBox 70×44 (1.59:1). Displayed square; excess is clipped/letterboxed.
export function HeroMonogram({ size = 24, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 70 44"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      {...props}
    >
      {/* Left thick diagonal of A */}
      <path fill="currentColor" d="M0 42 L11 42 L34 2 L23 2 Z" />
      {/* F top bar — horizontal rectangle from A peak to right edge */}
      <path fill="currentColor" d="M23 2 L70 2 L70 13 L23 13 Z" />
      {/* A right leg — short diagonal connecting top bar to crossbar */}
      <path fill="currentColor" d="M34 2 L45 2 L39 27 L28 27 Z" />
      {/* F lower bar / A crossbar */}
      <path fill="currentColor" d="M39 27 L63 27 L63 37 L39 37 Z" />
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

// ── The Engine — Hexagon with teal inner ring ─────────────────────────────────
//  Outer hex: copper/gold stroke. Inner hex: teal stroke with open centre.
//  Matches the brand mark (top-right quadrant).
export function EngineHexagon({ size = 24, ...props }: IconProps) {
  const outer = '20,1.5 34.64,10 34.64,30 20,38.5 5.36,30 5.36,10';
  const inner = '20,9 30.39,15 30.39,27 20,33 9.61,27 9.61,15';
  return (
    <svg
      width={size} height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* Outer hexagon — copper/gold stroke */}
      <polygon points={outer} stroke="currentColor" strokeWidth="2.5" fill="none" />
      {/* Inner hexagon — teal tint */}
      <polygon points={inner} stroke="#22D3EE" strokeWidth="2" fill="none" />
      {/* Centre open circle */}
      <circle cx="20" cy="20" r="4" stroke="#22D3EE" strokeWidth="2" fill="none" />
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
