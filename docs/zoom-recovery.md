# Reset a napplet's zoom

The iOS napplet menu offers **Reset zoom** after its native view connects. This
explicit action returns that view to its current minimum zoom. It leaves pinch,
the maximum zoom, accessibility preferences, guest bytes and guest data intact.
There is no automatic reset on blur, form submission or document changes.

The shell captures the exact view ref and ready generation when the user selects
the action, dismisses the menu, then rechecks the focused descriptor, identity,
runtime lifetime, foreground and navigation state before invoking it. Replaced
or unmounted refs are not resolved to a replacement. Focus changes, background,
close and identity changes cancel the queued frame; late outcomes cannot present
an error in another context. An unavailable target has no replay or retry.

The view-bound native prop command independently requires the exact session and
generation, current document URL, attached live/ready/loaded view, active focus
and foreground. A monotonic sequence is consumed once and expired commands are
rejected after one second; the app's correlated waiter ends after 1.1 seconds.
Native focus loss or background records a monotonic interruption boundary. A
command issued before that boundary cannot execute after a fast return. An
unconfirmed outcome is reported as such, without claiming the view stayed unchanged.
The native result returns directly to the app, without passing through the guest.
It uses only the public WK scroll-view zoom API. No new guest
namespace, capability, network access, signing or persistent authority is added.

Small publisher input fonts can trigger iOS focus zoom that persists after a
form is replaced with an article. A native layout fixture reproduced this at
1.283× and separately observed that a 16px input control stayed at 1×. Publisher
content can also overflow its layout independently; resetting native zoom does
not wrap an unbroken coordinate or otherwise rewrite the publication's CSS.

The fixture is a layout test with fixed public data. It does not replace ordinary
iPhone acceptance of the final shell menu and native view binding.
