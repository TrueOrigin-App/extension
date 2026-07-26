# C2PA test fixtures

Vendored from the [c2pa-rs](https://github.com/contentauth/c2pa-rs) test
suite (`sdk/tests/fixtures/`), commit `b9b446793a57b77b882f7cbe47449ace5826cbe2`,
licensed MIT OR Apache-2.0. Used only by unit tests; nothing here ships in
the built extension.

| File                        | Upstream path                                              | Purpose                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `C.jpg`                     | `sdk/tests/fixtures/C.jpg`                                 | Image with a valid C2PA manifest signed by the C2PA test cert chain. No digital source type — a manifest that declares neither AI nor capture.                                      |
| `no_manifest.jpg`           | `sdk/tests/fixtures/no_manifest.jpg`                       | Image with no C2PA metadata at all.                                                                                                                                                 |
| `test_cert_root_bundle.pem` | `sdk/tests/fixtures/certs/trust/test_cert_root_bundle.pem` | Trust anchors that chain the test cert to a root. With these as `trustAnchors`, `C.jpg` validates as **Trusted**; without them it is only **Valid**.                                |
| `store.cfg`                 | `sdk/tests/fixtures/certs/trust/store.cfg`                 | Matching trust store config (allowed EKU OIDs).                                                                                                                                     |
| `cloud.jpg`                 | `sdk/tests/fixtures/cloud.jpg`                             | Image whose only C2PA reference is a remote manifest URL (XMP `dcterms:provenance` pointing at `cai-manifests.adobe.com`). Exercises remote manifest fetching with a stubbed fetch. |
| `cloud_manifest.c2pa`       | `sdk/tests/fixtures/cloud_manifest.c2pa`                   | The manifest bytes the stubbed fetch serves for `cloud.jpg`'s remote URL.                                                                                                           |

The certificates are the publicly published c2pa-rs _test_ certificates
("FOR TESTING_ONLY") — they are not secrets and anchor nothing outside these
tests.
