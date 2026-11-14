TEST ONLY. Keys and certificates for the auth tests (company CA, client certificate signed by it,
and a self-signed "rogue" certificate). generate.ts creates them with OpenSSL before the tests
(Vitest globalSetup) when one is missing. They are ignored by git. Never use them outside the tests.
