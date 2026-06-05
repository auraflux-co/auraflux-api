# Lumi Education — Live Site Full Backup
# Site: learningwithlumi.com (ID: 1e983bcd-eab8-4e3d-ad53-c3a279abab8d)
# Captured: 2026-05-30
# Purpose: Complete pre-transfer audit — nothing gets lost

---

## SITE PROPERTIES
- **Display Name:** Lumi Education
- **Domain:** learningwithlumi.com
- **Email:** contact.us@learningwithlumi.com
- **Phone:** (571) 207-8373
- **Address:** 22930 Weybridge Square, Brambleton, VA 20148
- **Timezone:** America/New_York
- **Currency:** USD
- **Plan:** Premium

---

## INSTALLED APPS
- Wix Bookings (13d21c63-b5ec-5912-8397-c3a5ddb27a97)
- Wix Events & Tickets (140603ad-af8d-84a5-2c80-a0f60cb47351)
- Wix Forms (225dd912-7dea-4738-8688-4b8c6955ffc2)
- Wix Forms & Payments (14ce1214-b278-a7e4-1373-00cebd1bef7c)
- Wix Members Area (14cc59bc-f0b7-15b8-e1c7-89ce41d0e0c9)
- Wix Invoices (13ee94c1-b635-8505-3391-97919052c16f)
- Promote SEO (1480c568-5cbd-9392-5604-1148f5faffa0)

---

## BOOKINGS SERVICES
| ID | Name | Type | Visible | Price |
|---|---|---|---|---|
| 3590a425 | Free Telephonic Consultation | APPOINTMENT | ✅ Yes | Free |
| 8c9b85d6 | Personal Solution Planning | UNKNOWN | ❌ Hidden | - |
| c8346ae9 | Custom Project | UNKNOWN | ❌ Hidden | - |
| f486598a | Expert Guidance Package | UNKNOWN | ❌ Hidden | $1,500 |

**Active booking service:** Free Telephonic Consultation
- Duration: 45 min
- Buffer: 25 min between sessions
- URL: /booking-calendar/free-telephonic-consultation
- Location: Telephonic (phone number provided in form)
- Online booking: enabled, no manual approval

**Note:** 3 hidden placeholder services (Personal Solution Planning, Custom Project, Expert Guidance Package) — these are Wix template defaults, not real services. Safe to ignore.

---

## FORMS (see live_site_forms_snapshot.md for full field detail)
| ID | Name | Fields | Notes |
|---|---|---|---|
| 800c7d9f | Join as a Tutor | 23 | Has file upload, submit = "Register" (needs → "Submit Application") |
| 4b6dcd4e | Internship and Volunteering Form | 25 | Has file upload, missing student phone |
| 8d8c9223 | Final Summer Camp Registration Form | 24 | Has PRODUCT_LIST, week/session selection |
| 963ea820 | Contact Form | 8 | Simple, within free plan limit |
| 85608585 | Grade 3-5 3rd Week | 24 | Legacy per-week form |
| 9fea5d95 | Grade 3-5 1st Week | 24 | Legacy per-week form |
| ca09207c | Grade 3-5 4th Week | 24 | Legacy per-week form |

---

## VELO CODE (GitHub: auraflux-dev/lumi)
**Pages with actual code:** NONE — all 34 page files are empty boilerplate

**Only real code:**
- `src/backend/pay.j.jsw` — payment backend with promo codes:
  - Valid codes: SAVE5, FRIEND2026, WIXPRO (5% discount)
  - Base price: $100
  - Uses wix-pay-backend createPayment()

**Pages list (all empty):**
- Home, About Us, Tutoring, Summer Camps 2026, Contact Us
- Become a Lumi-nary, After School Programs, Daily Schedule for Our Camps
- Final Summer Camp Registration Form, Booking Calendar, Book Online
- Booking Form, Service Page, Inquiry Services Page
- Attendance Policy, Cancellation & Refund Policy, Medical & Allergy Policy, Privacy Policy
- Accessibility Statement, Account Settings, Weekend Workshops
- Events, Event Details & Registration, Schedule, Checkout, Cart Page, Side Cart
- Thank You Page, Comming Soon (sic)

---

## MEDIA LIBRARY (partial — first 10 files captured)
All images are on wixstatic.com CDN — they are NOT lost when plan changes.
Media files stay permanently attached to the account, not the plan.

Key custom images uploaded:
- Presentation in Class (edited x2) — classroom photo
- AI Generated children learning images (x4 variants)
- Blackboard with subjects image (AI generated)
- Summer camp background (colorful, AI generated)
- Flower Soap Bouquet (appears to be test/placeholder)

**Logo file ID:** 96955e_bcdebe4db6864d37aba6e23b2c2fd600~mv2.jpg

---

## WHAT HAPPENS WHEN YOU TRANSFER PREMIUM TO LUMI EDUCATION 1

### ✅ SAFE — Nothing is lost
| Item | Why safe |
|---|---|
| All page content / visual design | Stored in Wix editor — unaffected by plan |
| Media library / images | Stored on wixstatic.com CDN — unaffected by plan |
| Velo code (GitHub repo) | Already cloned locally + on GitHub |
| Bookings service config | Stored in Wix platform — unaffected by plan |
| Form submissions data | Stored in Wix platform — unaffected by plan |
| Site properties / SEO | Stored in Wix platform — unaffected by plan |
| Domain (learningwithlumi.com) | Domain ownership is separate from plan |

### ⚠️ BECOMES READ-ONLY on free plan
| Item | Impact |
|---|---|
| Forms with >10 fields (Tutor 23, Intern 25, Registration 24) | Can't edit fields — but still WORK and accept submissions |
| Wix Bookings | May lose some premium booking features |
| Wix Events | May lose ticket selling features |
| Wix Members Area | May restrict member login features |
| Custom domain | Domain stays connected — premium feature but domain itself safe |

### ❌ STOPS WORKING on free plan
| Item | Impact |
|---|---|
| Wix Payments / checkout | Payment processing requires premium |
| Registration form checkout (PRODUCT_LIST) | Won't process payments |

---

## TRANSFER SEQUENCE (safe order)

1. **Before anything:** This backup doc complete ✅
2. **Upgrade Lumi Education 1** to premium
3. **Immediately after upgrade** — I replicate via API:
   - Tutor form (23 fields + subject checkboxes)
   - Intern form (25 fields + student phone)
   - Registration form (24 fields)
   - Bookings service (Free Telephonic Consultation)
4. **Connect GitHub** to Lumi Education 1 (same auraflux-dev/lumi repo or new branch)
5. **Editor changes** (you/Shweta — 20 min):
   - Text fixes, button labels, image swaps
6. **Point domain** learningwithlumi.com → Lumi Education 1
7. **Test** forms, booking calendar, all links
8. **Old site** (learningwithlumi.com ID: 1e983bcd) becomes archive on free plan

---

## CONTACTS / SUBMISSIONS DATA
Form submission history lives in Wix CRM — completely safe, unaffected by plan changes.
Access via: Wix Dashboard → Inbox / Contacts → Form Submissions
