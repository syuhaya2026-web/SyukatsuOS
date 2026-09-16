# GitHub Pagesで公開する準備

## 保存先のしくみ

- GitHub Pages：HTML / CSS / JavaScript / アイコンだけを配信します。
- 端末：企業・進捗・予定・添付ファイルをブラウザのIndexedDBに保存します。
- アプリから記録や添付をGitHubへ送信する処理はありません。企業マークは指定した外部サイトから読み込みます。
- アプリのURLを他の人が開いても、あなたの端末の記録は表示されません。アプリ本体のコードは閲覧できます。

## 公開手順

1. GitHubで新しいリポジトリを作成します（例：SyukatsuOS）。無料プランでの簡単な公開はPublicリポジトリを使います。
2. リポジトリの「Add file → Upload files」から、下記の公開ファイルをアップロードしてコミットします。フォルダごとではなく、index.htmlがリポジトリの一番上に来る配置にします。
3. 「Settings → Pages → Build and deployment」で「Deploy from a branch」を選びます。
4. ブランチ「main」、フォルダ「/ (root)」を選択してSaveします。
5. 公開処理の完了後、Pagesに表示されたHTTPSのURLを開きます。

公開ファイル：

- index.html
- style.css
- app.js
- db.js
- manifest.webmanifest
- service-worker.js
- icon.svg
- icon-192.png
- icon-512.png
- .nojekyll（隠しファイル。MacではCommand + Shift + .で表示）

README.md、PUBLISH.md、整形設定もソース管理に含めて構いません。個人のメモ・添付・バックアップファイルはアップロードしません。アプリで登録した記録はソースフォルダには作成されません。

公式手順：https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site

## ホーム画面へ追加

- iPhone：公開URLをSafariで開き、共有メニューから「ホーム画面に追加」。
- Android：公開URLをChromeで開き、メニューの「アプリをインストール」または「ホーム画面に追加」。
- パソコン：対応ブラウザのインストール機能を利用します。

初回はオンラインで起動してください。アプリ本体のキャッシュ完了後はオフラインでも記録できます。ストアへの申請は不要です。

## 現在の記録を引き継ぐ場合

ローカルの http://127.0.0.1:8765 と公開URLは別の保存領域です。公開URLでは最初は空の状態になります。端末間の自動同期もありません。現在バックアップ・復元機能は未実装なので、既に登録した記録を移したい場合は、移行機能を追加してから移行します。元のブラウザデータは消さずに残してください。

## 公開後の更新

ソースを更新し、service-worker.jsのCACHE名を新しい番号へ変更して、同じリポジトリへコミットします。同じ公開URLであればIndexedDBの記録はそのままです。保存形式を変更するときはdb.jsにデータ移行処理が必要です。

## 現在の準備状況

PWA設定、ホーム画面アイコン、オフライン対応、相対URL、コード整形、Git除外設定は準備済みです。GitHubリポジトリの作成・アップロード・公開はまだ行っていません。
