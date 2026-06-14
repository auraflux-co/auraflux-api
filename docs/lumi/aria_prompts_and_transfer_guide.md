# Lumi Education 1 — Aria Prompts + Business Data Transfer Guide
# Date: 2026-05-30

---

## WHAT'S ALREADY DONE (no action needed)
- ✅ Free Telephonic Consultation booking service created
- ✅ Tutor form — all 8 subject checkbox groups added, submit = "Submit Application"
- ✅ Intern form — student phone number field added
- ✅ Registration form — week selection, session type, photo consent added
- ✅ Wix Bookings app installed
- ✅ Business contact info needs Aria (API rejected field format)

---

## ARIA PROMPTS — Run these in the Harmony editor one at a time

Open the Harmony editor for Lumi Education 1, click the Aria AI button, and paste each prompt.

---

### GLOBAL / SITE SETTINGS

**Prompt 1 — Business info:**
> Update the site's business contact information: email is contact.us@learningwithlumi.com, phone is (571) 207-8373, address is 22930 Weybridge Square, Brambleton, VA 20148. Set the site display name to "Lumi Education".

---

### HOMEPAGE

**Prompt 2 — Hero video:**
> On the homepage, replace the hero image or video with the Wix free video of a dinosaur going around a volcano. Search the Wix video library using the prompt "dinosaur volcano". This is the same video used on the original learningwithlumi.com site.

**Prompt 3 — Circle images:**
> On the homepage, replace the four circle images below the hero section with relevant people/education images. Use Wix free images. Suggested search prompts: "children learning", "kids tutoring", "students classroom", "after school program".

**Prompt 4 — Program cards bullet formatting:**
> On the homepage programs section, the bullet points in each program card are running together on one line. Fix the formatting so each bullet point appears on its own separate line. The four cards are: Summer Programs, After School Programs, 1:1 Tutoring, and Volunteering & Internships.

**Prompt 5 — Summer Programs button:**
> On the homepage, find the "View Program Schedule" button in the Summer Programs card. Change the button text to "See Program Offerings" and make sure clicking it goes to the Summer Programs page (not the schedule page).

---

### ABOUT US PAGE

**Prompt 6 — Who We Serve text:**
> On the About Us page, find the "Who We Serve" card. Change "Grades K–5" to "Pre-K to College".

**Prompt 7 — Mission image:**
> On the About Us page, replace the current mission statement image (which shows cars with clouds — a Wix library placeholder) with a free Wix image of a child making a robot. Search Wix free images with the prompt "child making robot" or "kids robotics".

**Prompt 8 — Vision image:**
> On the About Us page, replace the "Our Vision" image with a free Wix image of a student or child wearing virtual reality glasses. Search Wix free images with the prompt "child virtual reality glasses" or "confident learner VR".

---

### TUTORING PAGE

**Prompt 9 — Core Academics:**
> On the Tutoring page, find the section heading "Key Academics" and change it to "Core Academics". Also update the subtitle below it — it should read "Math, Reading, Science, Social Studies and more — Pre-K to College".

**Prompt 10 — Our Exclusive Quality:**
> On the Tutoring page, find the "Our Exclusive Quality" section. The heading and description text have changed from the original. Restore the section to say:
> Heading: "Our Exclusive Quality"
> Subtitle: "Our specialists are chosen with care to provide your student with premium academic support and dedicated site mentorship."
> The four quality cards should be: "Highly Trusted Tutoring Solutions", "Licensed Educators and Academic Graduates", "Proven Student Success", "Subject Matter Experts"

**Prompt 11 — Executive Functioning Skills:**
> On the Tutoring page, find the card that currently says "Personalized Mentorship and Training". Change the heading to "Executive Functioning Skills". Update the description to explain that Lumi tutors help students build executive functioning skills including organization, time management, focus, and study habits.

**Prompt 12 — Start Session button:**
> On the Tutoring page, find all buttons that say "Start Session". Change each one to say "Book a Free Consult" and make sure they link to the booking calendar page.

**Prompt 13 — Foreign Languages:**
> On the Tutoring page, find the "Foreign Languages" section or card. The subtitle currently says "Spanish, French, Latin". Change it to "Spanish, French, Latin, and more — All Levels".

---

### CONTACT US PAGE

**Prompt 14 — Bullet list formatting:**
> On the Contact Us page, find the "We can help with:" section. The bullet points are running together on one line. Fix the formatting so each item appears on its own line. The items should be:
> • Program recommendations based on grade and goals
> • Scheduling tutoring sessions
> • Summer Programs details and registration
> • Special learning needs or customized plans

---

### SUMMER PROGRAMS PAGE

**Prompt 15 — Testimonials:**
> On the Summer Programs page, add a testimonials section with these two reviews:
>
> ⭐⭐⭐⭐⭐
> "Just the camp my child needs this summer to have fun while learning new skills."
> — Sarah M., Ashburn Parent
>
> ⭐⭐⭐⭐⭐
> "We registered both our kids (2nd and 5th grade) and they both are looking forward to an incredible experience. The grade-specific activities mean they aren't just 'lumped together' — they each have projects tailored to their level. Worth every penny!"
> — The Thompson Family, Herndon

---

### JOIN OUR TEAM PAGE

**Prompt 16 — Inspirational banner:**
> On the Join Our Team (Become a Lumi-nary) page, add an inspirational banner at the very top of the page. The banner should have a light colored background and say something like: "Shape the Next Generation of Learners — Join the Lumi Education Team" with a subtitle like "We're looking for passionate educators, tutors, and mentors." Use Lumi's turquoise brand color for the text or accent.

---

### NAVIGATION

**Prompt 17 — Contact Us in nav:**
> Add "Contact Us" as a navigation menu item in the main site header. It should link to the Contact Us page.

---

### FOOTER

**Prompt 18 — Footer logo:**
> In the footer, make sure the Lumi Education logo uses the darker turquoise version. If there is a lighter version, swap it for the darker one. Also confirm the footer Quick Links show: About Us, Summer Programs, Tutoring, Join Our Team, Contact Us.

---

### BOOKING CALENDAR

**Prompt 19 — Add booking page:**
> Add a Booking Calendar page to the site that shows the "Free Telephonic Consultation" service. Connect it to the Wix Bookings app. All "Book a Free Consult" buttons across the site should link to this booking calendar page.

---

## BUSINESS DATA TRANSFER — What Wix Does and Doesn't Move

### The Core Answer
When you transfer a premium plan from Site A to Site B, **only the plan moves — business data does NOT automatically transfer**. Here's exactly what that means:

---

### ✅ DATA THAT IS SAFE (stays on the account, not the plan)

| Data | Where it lives | Action needed |
|---|---|---|
| **Contacts** | Wix CRM — account level | Nothing — all contacts stay in your account and are accessible from any site dashboard |
| **Form submissions** | Attached to the form on old site | Export as CSV from old site dashboard before going live |
| **Media/images** | wixstatic.com CDN — account level | Nothing — all images stay accessible |
| **Bookings history** | Attached to old site | Export from Wix dashboard → Bookings → past appointments |
| **Invoices** | Wix Invoices — account level | Nothing — invoices stay in your account |

---

### ⚠️ DATA THAT NEEDS MANUAL SETUP ON NEW SITE

| Item | What to do |
|---|---|
| **Wix Payments** | Reconnect: New site dashboard → Accept Payments → Connect Wix Payments. Your banking info is on the account so it should repopulate. |
| **Booking calendar availability** | Set working hours on the new booking service. Go to Bookings → Free Telephonic Consultation → Manage Availability → set your available hours. |
| **Booking staff member** | The "Business Owner" staff member was auto-created. Add your real name and photo in Bookings → Staff. |
| **Registration form payments** | Once Wix Payments is connected, add the session pricing to the registration form's payment/checkout. |
| **Google Reviews widget** | Reconnect: go to Add Apps in editor → find Google Reviews → reconnect your Google Business account. |
| **Chat widget** | Re-add: if using Wix Chat, add it from the editor. If using third-party, re-add via Custom Code embeds. |
| **Email notifications** | Check: Wix Dashboard → Automations → verify form submission notifications are going to contact.us@learningwithlumi.com |
| **Domain** | Final step: Wix Dashboard → Domains → point learningwithlumi.com to Lumi Education 1 |

---

### ❌ DATA THAT CANNOT BE TRANSFERRED

| Item | Why | Workaround |
|---|---|---|
| **Past payment transactions** | Payment history is attached to old site's payment processor instance | Export as CSV from old site → keep for records |
| **Event registrations** | Attached to old site's Wix Events | Export attendee list from old site before switching domain |
| **Members / login accounts** | Member accounts are site-specific | Members will need to re-register on new site |
| **Old form submissions** | Attached to old site's forms | Export CSV: old site dashboard → Forms → each form → Export |

---

### RECOMMENDED ORDER OF OPERATIONS

1. ✅ All API work done (forms, bookings)
2. ✅ Run all Aria prompts above
3. Connect Wix Payments on new site
4. Set booking availability calendar hours
5. Export all form submissions from old site as CSV (backup)
6. Export contacts list from old site as CSV (backup)
7. Test all forms submit correctly on new site
8. Test booking calendar works end-to-end
9. Point domain learningwithlumi.com → Lumi Education 1
10. Monitor for 24-48 hours after domain switch

---

### HOW TO EXPORT FROM OLD SITE (do before domain switch)

**Form submissions:**
- Old site dashboard → Forms & Submissions → click each form → Export to CSV

**Contacts:**
- Old site dashboard → Contacts → click Export → All Contacts → CSV

**Bookings:**
- Old site dashboard → Bookings → Calendar or List view → Export

**Event attendees:**
- Old site dashboard → Events → each event → Guests → Export
