# Web Page Performance Analysis Agent

The CWV Agent will analyze the specified page for performance issues and suggest various improvements.

## Usage

First install all dependencies:
```sh
npm install
```

Then run the script via:
```sh
node index.js <url> <device>
```

where:
- `url` is the page you want to test, like `https://www.aem.live`
- `device` is the device type you want to optimize for. Either `mobile` or `desktop` (defaults to `mobile`)