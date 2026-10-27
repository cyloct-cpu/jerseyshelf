# WhatsApp storefront navigation fix — 2026-10-19

The public site showed HTTP 415 at `/contact/whatsapp`. Production logs also showed successful 303 responses immediately before the failed request. The exact source of the malformed follow-up request was not retained in the logs.

Storefront contact forms now submit URL-encoded data through a same-origin request with an explicit JSON response. A synchronously opened window then navigates to the server-generated, validated `https://wa.me` URL. This separates form submission from external navigation. Blocked popups fall back to the current window. Errors close the blank window and display the server error; CSRF, origin validation, rate limits, merchant selection and order permissions remain enforced.

The contact URL also accepts direct GET navigation. Form encoding is explicit for native submissions.

Only WhatsApp changes were deployed. The local country-picker changes in `store.js` were excluded from this release. Previous production files were backed up at `/www/wwwroot/jerseyshelf/storage/backups/whatsapp-fix-20261019-134733` before deployment.

Validation: 29 WhatsApp unit and HTTP regression tests passed. New coverage checks direct navigation, JSON responses, immutable merchant selection, selected product customization, expired CSRF errors, and private-order permission checks. Production browser results are recorded separately in `whatsapp-live-fix-2026-10-19.json`. Browser verification captures navigation at wa.me without sending messages.
