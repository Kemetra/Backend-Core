/**
 * RT-430 — headers for a cookie-authenticated unsafe request in tests.
 *
 * The API refuses a cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` unless
 * its `Origin` is the API's own origin (derived from `Host`) or is listed in
 * `ALLOWED_ORIGINS`. Supertest connects on an ephemeral port, so the test
 * pins `Host` and sends the matching `Origin`, as a browser on the Console's
 * origin would. Jest runs with NODE_ENV=test, so the scheme is plain http.
 *
 *   await http().post("/api/v1/stores").set(SAME_ORIGIN).set("Cookie", cookie)
 */
export const SAME_ORIGIN = Object.freeze({
  Host: "api.test",
  Origin: "http://api.test",
});
