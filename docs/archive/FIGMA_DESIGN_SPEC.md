# CWN Production Dashboard - Figma Design Specification

**Version**: Railway Deployment (v2.0)
**Date**: 2026-04-07
**Purpose**: Design specs for Figma mockup + Railway UI rebuild

---

## Design System

### Color Palette

#### Primary Colors
```
Brand Gold:     #C7AF4F (primary accent)
Gold Hover:     #F0D060 (interactive states)
Gold Dim:       rgba(199, 175, 79, 0.3) (borders, 30% opacity)
Gold Glow:      rgba(199, 175, 79, 0.15) (backgrounds, 15% opacity)
```

#### Background Colors
```
BG Dark:        #060A12 (main background, inputs)
BG Card:        #0D1524 (cards, panels)
BG Sidebar:     #0A0F1E (sidebar background)
BG Header:      linear-gradient(90deg, #22304B, #1A2538)
BG Card Header: linear-gradient(90deg, #131F38, #0F1A30)
```

#### Text Colors
```
Text Primary:   #FFFFFF (white, headings)
Text Secondary: rgba(255, 255, 255, 0.85) (body text)
Text Muted:     rgba(255, 255, 255, 0.5) (labels)
Text Disabled:  rgba(255, 255, 255, 0.35) (metadata)
```

#### Status Colors
```
Pending:    #F39C12 (orange) - bg: rgba(243, 156, 18, 0.15)
Processing: #3498DB (blue)   - bg: rgba(52, 152, 219, 0.15)
Success:    #2ECC71 (green)  - bg: rgba(46, 204, 113, 0.15)
Error:      #E74C3C (red)    - bg: rgba(231, 76, 60, 0.15)
```

#### Platform/Feature Colors
```
Canva:   #8B3DFF → #A060FF (purple gradient)
FFmpeg:  #E67E22 → #F39C12 (orange gradient)
YouTube: #FF0000 (red) - use sparingly
TikTok:  #FF2D55 (pink)
Instagram: #C13584 (magenta)
```

---

### Typography

#### Font Families
```css
Headings:    'Bebas Neue', sans-serif
Body:        'Barlow Condensed', Arial, sans-serif
Monospace:   monospace (code, logs, timestamps)
```

#### Font Sizes
```
Page Title:       26px (header logo)
Section Title:    20px (sec-title)
Card Title:       14px (card-title)
Button Text:      14px (all buttons)
Body Text:        13px (inputs, labels)
Metadata:         11px (job details, timestamps)
Badge Text:       10px (status badges)
Logs:             10px (assembly logs, console output)
Tiny Labels:      9px (micro-status indicators)
```

#### Font Weights
```
Light:   400 (body text)
Bold:    700 (buttons, labels, headings)
```

#### Letter Spacing
```
Ultra Wide:  4px (main header "CLIPZWORLD NEWS PRODUCTION")
Wide:        3px (section titles, button text)
Standard:    2px (card titles, badges)
Normal:      1px (sidebar buttons)
Tight:       0px (body text)
```

---

### Spacing System

#### Padding Scale
```
Micro:  3-6px   (badges, tight spacing)
XS:     8-10px  (input padding, small buttons)
SM:     12-14px (card padding, panels)
MD:     16-20px (section padding)
LG:     24px    (header padding)
XL:     32px+   (major section breaks)
```

#### Border Radius
```
Sharp:   0px   (none)
Subtle:  3-4px (small elements, badges)
Default: 6px   (cards, panels, buttons)
Soft:    8px   (major cards)
Round:   10px  (pill badges)
Circle:  50%   (status dots)
```

---

### Components

## 1. Buttons

### Primary Button (Gold)
```css
.btn-gold {
  background: #C7AF4F;
  color: #060A12;
  font-family: 'Bebas Neue', sans-serif;
  font-size: 14px;
  letter-spacing: 3px;
  padding: 9px 20px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
}
.btn-gold:hover {
  background: #F0D060;
}
```

**Use For**: Primary actions (Generate, Submit, Send)

---

### Outline Button (Transparent)
```css
.btn-outline {
  background: transparent;
  border: 1px solid rgba(199, 175, 79, 0.3);
  color: #C7AF4F;
  /* typography same as btn-gold */
}
.btn-outline:hover {
  background: rgba(199, 175, 79, 0.1);
}
```

**Use For**: Secondary actions (Configure, Refresh, Copy)

---

### Destructive Button (Red)
```css
.btn-red {
  background: #C0392B;
  color: #FFFFFF;
}
.btn-red:hover {
  background: #E74C3C;
}
```

**Use For**: Delete, Clear, Remove actions

---

### Success Button (Green)
```css
.btn-green {
  background: #27AE60;
  color: #FFFFFF;
}
.btn-green:hover {
  background: #2ECC71;
}
```

**Use For**: Confirm, Approve, Publish actions

---

### Platform-Specific Buttons
```css
/* Canva */
.btn-canva {
  background: #8B3DFF;
  color: #FFFFFF;
}

/* FFmpeg */
.btn-ffmpeg {
  background: #E67E22;
  color: #FFFFFF;
}
```

---

### Button Sizes
```css
.btn-sm {
  font-size: 12px;
  padding: 6px 14px;
  letter-spacing: 2px;
}

.btn-md {
  /* default size (9px 20px) */
}

.btn-lg {
  font-size: 16px;
  padding: 12px 28px;
  letter-spacing: 4px;
}
```

---

## 2. Cards & Panels

### Standard Card
```css
.card {
  background: #0D1524;
  border: 1px solid rgba(199, 175, 79, 0.12);
  border-radius: 8px;
  overflow: hidden;
}

.card-header {
  background: linear-gradient(90deg, #131F38, #0F1A30);
  padding: 12px 16px;
  border-bottom: 1px solid rgba(199, 175, 79, 0.1);
}

.card-title {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 14px;
  color: #C7AF4F;
  letter-spacing: 2px;
}

.card-body {
  padding: 16px;
}
```

**Layout Pattern**:
```
┌────────────────────────────┐
│ CARD TITLE          [icon] │ ← card-header (gradient)
├────────────────────────────┤
│                            │
│  Card content here         │ ← card-body
│                            │
└────────────────────────────┘
```

---

### Assembly Panel (FFmpeg/Processing)
```css
.assembly-panel {
  background: #060A12;
  border: 1px solid rgba(230, 126, 34, 0.3); /* orange */
  border-radius: 6px;
  padding: 14px;
}

.assembly-title {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 12px;
  color: #E67E22; /* orange */
  letter-spacing: 2px;
}
```

**Use For**: FFmpeg assembly progress, processing status

---

## 3. Status Tags

### Tag Component
```css
.tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 2px;
  padding: 3px 10px;
  border-radius: 10px; /* pill shape */
  border: 1px solid;
}

.tag-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 1.2s infinite;
}
```

### Status Variants
```css
.tag-pending {
  background: rgba(243, 156, 18, 0.15);
  color: #F39C12;
  border-color: rgba(243, 156, 18, 0.3);
}

.tag-processing {
  background: rgba(52, 152, 219, 0.15);
  color: #3498DB;
  border-color: rgba(52, 152, 219, 0.3);
}

.tag-done {
  background: rgba(46, 204, 113, 0.15);
  color: #2ECC71;
  border-color: rgba(46, 204, 113, 0.3);
}

.tag-failed {
  background: rgba(231, 76, 60, 0.15);
  color: #E74C3C;
  border-color: rgba(231, 76, 60, 0.3);
}
```

**Layout**:
```
┌─────────────────┐
│ ● PROCESSING    │ ← pulsing dot + text
└─────────────────┘
```

---

## 4. Form Inputs

### Text Input / Select / Textarea
```css
.field input,
.field select,
.field textarea {
  width: 100%;
  background: #060A12;
  border: 1px solid rgba(199, 175, 79, 0.2);
  color: #FFFFFF;
  font-family: 'Barlow Condensed', Arial, sans-serif;
  font-size: 13px;
  padding: 8px 12px;
  border-radius: 4px;
}

.field input:focus,
.field select:focus,
.field textarea:focus {
  outline: none;
  border-color: #C7AF4F;
  box-shadow: 0 0 0 2px rgba(199, 175, 79, 0.1);
}
```

### Label
```css
.field label {
  display: block;
  font-size: 11px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.5);
  letter-spacing: 1px;
  margin-bottom: 6px;
}
```

**Field Pattern**:
```
LABEL TEXT
┌─────────────────────┐
│ input value         │
└─────────────────────┘
```

---

## 5. Progress Bars

### Standard Progress
```css
.progress-wrap {
  background: rgba(255, 255, 255, 0.06);
  border-radius: 4px;
  height: 6px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #C7AF4F, #F0D060);
  border-radius: 4px;
  transition: width 0.5s ease;
}
```

### Platform-Specific Progress
```css
.progress-bar.canva-bar {
  background: linear-gradient(90deg, #8B3DFF, #A060FF);
}

.progress-bar.ffmpeg-bar {
  background: linear-gradient(90deg, #E67E22, #F39C12);
}
```

**Layout**:
```
┌────────────────────────┐
│█████████░░░░░░░░░      │ ← gold gradient fill
└────────────────────────┘
```

---

## 6. Sidebar Navigation

### Sidebar Button
```css
.sidebar-btn {
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.5);
  font-family: 'Barlow Condensed', sans-serif;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 1px;
  padding: 10px 20px;
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  transition: all 0.15s;
}

.sidebar-btn:hover {
  background: rgba(199, 175, 79, 0.06);
  color: #FFFFFF;
}

.sidebar-btn.active {
  background: rgba(199, 175, 79, 0.1);
  color: #C7AF4F;
  border-right: 3px solid #C7AF4F;
}
```

**Icon Pattern**:
```
┌─────────────────────────┐
│ + Generate Videos       │
│ Q Job Queue             │ ← icon (1 char) + label
│ C Content Calendar      │
├─────────────────────────┤ ← divider
│ B NBA Compilation   ◀   │ ← active (gold border right)
│ N News Compilation      │
└─────────────────────────┘
```

---

## 7. Job Queue Item

### Job Row
```css
.job-row {
  background: #0D1524;
  border: 1px solid rgba(199, 175, 79, 0.1);
  border-radius: 6px;
  padding: 12px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.job-title {
  font-size: 13px;
  font-weight: 700;
  color: #FFFFFF;
}

.job-meta {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.35);
  font-family: monospace;
}
```

**Layout**:
```
┌────────────────────────────────────────────┐
│ Twitch Compilation - kai_cenat + 2 more   │
│ twitch_20260407_123456                     │ ● PROCESSING
│ Gate 1: 92/100  Gate 2: --                 │
└────────────────────────────────────────────┘
```

---

## Layout Structure

### Page Layout
```
┌─────────────────────────────────────────────────┐
│  HEADER (gradient, 3px gold bottom border)     │ 60px
├──────┬──────────────────────────────────────────┤
│      │                                          │
│  S   │         MAIN CONTENT AREA                │
│  I   │                                          │
│  D   │  ┌────────────────────────────────┐     │
│  E   │  │ SECTION TITLE                  │     │
│  B   │  ├────────────────────────────────┤     │
│  A   │  │                                │     │
│  R   │  │  Cards / Content               │     │
│      │  │                                │     │
│ 240px│  └────────────────────────────────┘     │
│      │                                          │
└──────┴──────────────────────────────────────────┘
```

**Dimensions**:
- Header height: 60px
- Sidebar width: 240px
- Main content: flex-grow
- Content max-width: 1400px (center)
- Content padding: 24px

---

## Railway-Specific Improvements

### 1. Responsive Breakpoints
```css
/* Desktop (default) */
@media (min-width: 1024px) {
  /* sidebar visible, full layout */
}

/* Tablet */
@media (max-width: 1023px) {
  .sidebar { width: 200px; }
}

/* Mobile */
@media (max-width: 768px) {
  .sidebar {
    position: fixed;
    transform: translateX(-100%);
    /* toggle with hamburger menu */
  }
  .main-content {
    padding: 16px;
  }
}
```

---

### 2. Loading States
```css
.skeleton {
  background: linear-gradient(
    90deg,
    rgba(255,255,255,0.03) 25%,
    rgba(255,255,255,0.06) 50%,
    rgba(255,255,255,0.03) 75%
  );
  background-size: 200% 100%;
  animation: loading 1.5s infinite;
  border-radius: 4px;
}

@keyframes loading {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

**Use For**: Job queue while polling, cards loading data

---

### 3. Empty States
```css
.empty-state {
  text-align: center;
  padding: 60px 24px;
  color: rgba(255, 255, 255, 0.35);
}

.empty-state-icon {
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.3;
}

.empty-state-title {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 18px;
  color: rgba(255, 255, 255, 0.5);
  letter-spacing: 2px;
  margin-bottom: 8px;
}

.empty-state-desc {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.35);
}
```

**Use For**: Empty job queue, no games selected, no stories fetched

---

### 4. Toast Notifications
```css
.toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  background: #0D1524;
  border: 1px solid rgba(199, 175, 79, 0.3);
  border-radius: 6px;
  padding: 12px 16px;
  min-width: 300px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  animation: slideIn 0.3s ease;
}

.toast.success {
  border-color: rgba(46, 204, 113, 0.5);
}

.toast.error {
  border-color: rgba(231, 76, 60, 0.5);
}

@keyframes slideIn {
  from {
    transform: translateX(400px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
```

**Use For**: Copy success, job started, errors

---

## Accessibility Considerations

### Focus States
```css
*:focus {
  outline: 2px solid #C7AF4F;
  outline-offset: 2px;
}

button:focus {
  outline: none;
  box-shadow: 0 0 0 3px rgba(199, 175, 79, 0.3);
}
```

### High Contrast Mode
```css
@media (prefers-contrast: high) {
  .tag {
    border-width: 2px;
  }
  .card {
    border-width: 2px;
  }
}
```

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## Figma Setup Checklist

### Color Styles to Create
- [ ] Primary/Gold
- [ ] Primary/Gold Hover
- [ ] BG/Dark
- [ ] BG/Card
- [ ] BG/Sidebar
- [ ] Text/Primary
- [ ] Text/Secondary
- [ ] Text/Muted
- [ ] Status/Pending
- [ ] Status/Processing
- [ ] Status/Success
- [ ] Status/Error

### Text Styles to Create
- [ ] Heading/Page Title (Bebas Neue, 26px)
- [ ] Heading/Section (Bebas Neue, 20px)
- [ ] Heading/Card (Bebas Neue, 14px)
- [ ] Body/Default (Barlow Condensed, 13px)
- [ ] Body/Small (Barlow Condensed, 11px)
- [ ] Label/Button (Bebas Neue, 14px, 700, 3px spacing)
- [ ] Label/Badge (Barlow Condensed, 10px, 700, 2px spacing)
- [ ] Monospace/Log (monospace, 10px)

### Components to Create
- [ ] Button (Primary, Outline, Red, Green variants)
- [ ] Card (with header, body)
- [ ] Status Tag (Pending, Processing, Done, Failed)
- [ ] Input Field (text, select, textarea)
- [ ] Sidebar Button (default, hover, active states)
- [ ] Progress Bar (default, canva, ffmpeg variants)
- [ ] Job Row
- [ ] Assembly Panel
- [ ] Empty State
- [ ] Toast Notification

---

## Railway Deployment Notes

### Environment-Specific Adjustments
- Use `Railway.app` domain for prod
- Ensure all localhost references removed
- Add Railway health check endpoint
- Configure CORS for production domain

### Performance Optimizations
- Lazy load job queue (pagination)
- Debounce status polling (3-5 seconds)
- Cache streamer/game data in localStorage
- Minimize re-renders on status updates

---

**Ready for Figma!** Use this spec to create components, establish design tokens, and build mockups for the Railway deployment.
