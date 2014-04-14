define(function () {
    "use strict";

    return {
        baseUrl: "../src",
        paths: {
            sax: "../lib/sax/lib/sax"
        },
        shim: {
            sax: {exports: "sax"}
        },
        packages: [
            "models", "soap", "ssdp",
            {name: "unitTests", location: "../test/unit"},
            {name: "integrationTests", location: "../test/integration"},
            {name: "fixtures", location: "../test/fixtures"}
        ]
    };
});
