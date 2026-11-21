# BinaryLens daily tweet drafts

Run `auto_tweet.py` once a day to collect public X examples, draft 24 original
posts with a local Ollama model, save the draft text and intent links to
`tweet_links_YYYY-MM-DD.txt`, and open 24 pre-filled composers in Google Chrome.
The script does not publish posts; review each draft and click **Post** yourself.

## Setup

1. Install Python 3.10 or newer and Google Chrome.
2. Install [Ollama](https://ollama.com/) and download a model:

   ```sh
   ollama pull llama3.1:8b
   ```

3. In this folder, install the browser automation dependency:

   ```sh
   python3 -m pip install -r requirements.txt
   ```

4. Run the generator:

   ```sh
   python3 auto_tweet.py
   ```

The script does not pause for sign-in. It tries to read your public profile and
top-ranked public search results while signed out. X may limit what it exposes
without an account session; if so, the provided `tweet.txt` is used as the
writing-style sample and the script generates evergreen drafts without trend
examples. Make sure Ollama is running before launching the script.

The script opens the composer links in your normal Google Chrome profile.
Posting still requires you to be signed in to X in Chrome. The links only
pre-fill the composer; they do not bypass X's sign-in requirement or post for
you.

Set `OLLAMA_MODEL` to use another model already installed in Ollama, for example:

```sh
OLLAMA_MODEL=qwen2.5:7b python3 auto_tweet.py
```

X page structure and access can change; if the script cannot collect enough
posts, it stops with an error instead of silently generating from incomplete
examples. The output text file is saved before Chrome tabs are opened.
