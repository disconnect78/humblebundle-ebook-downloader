# humblebundle-ebook-downloader

An easy way to download ebooks from your humblebundle account

## Installation

To run the tool, you can either install NodeJS and use npm to install it, or install Docker and run it as a docker container.

### NPM
To install it via npm, run:

```shell
$ npm install -g humblebundle-ebook-downloader
```

You can now use the tool by running the `humblebundle-ebook-downloader` command.

### Docker
To run the tool via Docker, run:

```shell
docker run -v $(PWD)/download:/download --rm -it dmarby/humblebundle-ebook-downloader -d /download --auth-token "auth_string_here"
```
This will download the books to the `download` folder in your current work directory.

Note that you need to get your auth token from the authentication cookie in your browser after logging in to the humblebundle website (_simpleauth_sess) when using Docker, as the option to interactively log in isn't available.
When using the tool installed via npm, it will launch a browser and let you log in interactively instead.

## Usage

```shell
$ humblebundle-ebook-downloader --help

  Usage: humblebundle-ebook-downloader [options]

  Options:
    -V, --version                              output the version number
    -d, --download-folder <downloader_folder>  Download folder (default: "download")
    -l, --download-limit <download_limit>      Parallel download limit (default: 1)
    -f, --formats <formats>                    Comma-separated list of formats to download (all, cbz, epub, mobi, pdf, pdf_hd, prc,
                                               video) (default: "pdf")
    --filter <filter>                          Only display bundles with this text in the title
    --auth-token <auth-token>                  Optional: If you want to run headless, you can specify your authentication cookie
                                               from your browser (_simpleauth_sess)
    -k, --keys <keys>                          Comma-separated list of specific purchases to download
    -a, --all                                  Download all bundles
    --debug                                    Enable debug logging (default: false)
    -h, --help                                 display help for command
```

Formats and keys should be specified as a list like `gamekey1,gamekey2,gamekey3`.

Keys can be found by opening a bundle from the [Purchased Products](https://www.humblebundle.com/home/purchases) page; the key will be in the url `https://www.humblebundle.com/downloads?key=gamekey1`.

## Contributors
- [J. Longman](https://github.com/jlongman)
- [Johannes Löthberg](https://github.com/kyrias)
- [jaycuse](https://github.com/jaycuse)

## License
See [LICENSE.md](LICENSE.md)
