# Paibot IaC

[English](README.md) | **日本語**

インフラを1回書けば、**AWS・Google Cloud・Azure** の Terraform / OpenTofu を生成します。同じファイルは、どのクラウドでも同じ意味になります。どのサブネットがインターネットに出られるか、何が入ってこられるか、どのバケットが非公開か、がそろいます。

```yaml
# infra.yaml
name: demo
sshKey: ~/.ssh/id_ed25519.pub
targets:
  - { cloud: aws, region: ap-northeast-1 }
  - { cloud: gcp, region: asia-northeast1, project: my-project }
  - { cloud: azure, region: japaneast }

networks:
  - name: main
    cidr: 10.20.0.0/16
    nat: true                       # private のサブネットから外へは出られる。外からは入れない
    subnets:
      - { name: edge, cidr: 10.20.0.0/24, public: true }
      - { name: app,  cidr: 10.20.1.0/24 }

instances:
  - name: web
    size: small
    subnet: main/edge
    publicIp: true
    ingress: [{ ports: [80, 443], from: [0.0.0.0/0] }]
  - name: worker
    size: medium
    subnet: main/app
    ingress: [{ ports: [8080], from: [10.20.0.0/24] }]

buckets:
  - { name: demo-artifacts-20261112, versioning: true }
```

```sh
npx @paibot/iac gen          # out/aws, out/gcp, out/azure に main.tf.json を書く
npx @paibot/iac plan aws     # gen して out/aws で tofu init と tofu plan
npx @paibot/iac apply gcp
```

plan・apply・状態の管理は OpenTofu か Terraform に任せます。出力はただの `main.tf.json` なので、`tofu` や `terraform` を自分で実行しても構いません。

## 「同じ意味」になるもの

| 書くもの | AWS | Google Cloud | Azure |
|---|---|---|---|
| `network` | VPC | カスタムモードの VPC | リソースグループ + VNet |
| `public: true` のサブネット | インターネットゲートウェイへの経路 | （外部 IP を持てる） | （パブリック IP を持てる） |
| private のサブネット | 外への経路なし | 外部 IP なし | 既定の外向き通信を**オフ** |
| `nat: true` | 最初の public サブネットに NAT Gateway + 経路 | Cloud Router + Cloud NAT（private のサブネットだけ） | private のサブネットに NAT Gateway |
| `ingress` | セキュリティグループのルール | ネットワークタグで当てるファイアウォール | NSG のルール + **それ以外は VNet 内からも拒否** |
| `size` | `paibot-iac sizes` を参照 | | |
| `userData` | cloud-init の user data | cloud-init の `user-data` メタデータ | cloud-init の custom data |
| バケット | S3（公開をブロック） | GCS（uniform access、公開を防止） | ストレージアカウント + 非公開のコンテナ |

なので、どのクラウドでも次のようになります。

- インスタンスがインターネットに出られるのは、`publicIp: true` のときか、`nat: true` のネットワークの private サブネットにいるときだけ。
- 入ってこられるのは `ingress` に書いたものだけ。同じネットワークの中からも、書いていなければ入れません（Azure は既定で通しますが、Paibot IaC が塞ぎます）。
- インスタンスから外向きの通信は絞りません。

一部のクラウドでしか成り立たない書き方はエラーにします。たとえば private サブネットにパブリック IP を付ける、置き場所の public サブネットがないのに NAT を使う、などです。`paibot-iac check` は問題をまとめて全部出します。

## サイズとイメージ

```
$ paibot-iac sizes
size        aws            gcp             azure
small       t3.medium      e2-medium       Standard_B2s            2 vCPU, 4 GB (burstable)
medium      m6i.large      e2-standard-2   Standard_D2s_v5         2 vCPU, 8 GB
large       m6i.xlarge     e2-standard-4   Standard_D4s_v5         4 vCPU, 16 GB
xlarge      m6i.2xlarge    e2-standard-8   Standard_D8s_v5         8 vCPU, 32 GB
gpu-small   g6.xlarge      g2-standard-4   Standard_NC4as_T4_v3    1 GPU, 4 vCPU (L4 24 GB on AWS/GCP, T4 16 GB on Azure)

images: ubuntu-24.04, ubuntu-22.04
```

ログインユーザーはどこでも `ubuntu` です。GPU のドライバはイメージに入っていません。

## 共通の言葉で足りないとき

```yaml
instances:
  - name: llm
    size: gpu-small
    overrides:
      azure: { type: Standard_NV36ads_A10_v5 }            # そのクラウドの型番
      aws:   { image: ami-0123456789abcdef0 }              # そのクラウドのイメージ
extra:
  aws:                                                     # 生の tf.json。out/aws にだけ混ぜる
    resource:
      aws_flow_log: { main: { vpc_id: "${aws_vpc.main.id}", traffic_type: ALL, log_destination: "..." } }
```

## TypeScript で書く

`infra.ts` にすると、型チェックと補完が効きます。Node 22.18 以上（型の除去）と、ES モジュールのプロジェクト（`"type": "module"`）が必要です。そうでないときは `infra.mts` という名前にしてください。

```ts
import { defineInfra } from "@paibot/iac";

export default defineInfra({
  name: "closed-llm",
  sshKey: "~/.ssh/id_ed25519.pub",
  targets: [
    { cloud: "aws", region: "us-east-1" },
    { cloud: "gcp", region: "us-central1", project: "my-project", zone: "us-central1-c" },
  ],
  networks: [{ name: "vpc", cidr: "10.50.0.0/16", subnets: [{ name: "gpu", cidr: "10.50.10.0/24" }] }],
  instances: [{ name: "llm", size: "gpu-small", subnet: "vpc/gpu", diskGb: 200 }],
});
```

ライブラリとしても使えます。`generate(infra)` は target ごとに tf.json のオブジェクトを返します。

## 項目一覧

| キー | |
|---|---|
| `name` | スタック名。クラウドのリソース名の頭に付く |
| `targets[]` | `cloud`（`aws` / `gcp` / `azure`）、`region`、`project`（gcp）、`zone`（gcp。既定は `<region>-a`）、`name`（出力先のフォルダ名。既定はクラウド名） |
| `sshKey` | 公開鍵そのもの、または公開鍵のパス（定義ファイルからの相対パスか `~/`）。Azure の VM には必須 |
| `networks[]` | `name`、`cidr`、`nat`、`subnets[]`（`name`、`cidr`、`public`） |
| `instances[]` | `name`、`size`、`image`、`subnet`（`network/subnet`）、`diskGb`（既定 30）、`publicIp`、`ingress[]`（`protocol` は tcp/udp、`ports` は `22` や `"8000-8100"`、`from` は CIDR）、`userData` か `userDataFile`、`overrides.<cloud>`（`type`、`image`） |
| `buckets[]` | `name`、`versioning`。Azure ではハイフンを除いた名前がストレージアカウント名になる（3〜24文字） |
| `extra.<cloud>` | そのクラウドの出力に混ぜる生の tf.json |

### 認証

生成したコードは、各プロバイダのふつうの認証を使います。AWS は `AWS_PROFILE` など、GCP は `gcloud auth application-default login`、Azure は `az login` と `ARM_SUBSCRIPTION_ID` です。

### 状態

状態は `out/<target>/` に置かれます（`extra` でバックエンドを足せば別の場所にもできます）。リソースがある間は、このフォルダを消さないでください。

## いまの状態

0.1 で扱えるのは、ネットワーク・NAT・VM・ファイアウォール・バケットです。例はすべて、3クラウドとも `tofu validate` と `terraform validate` で確かめています（`npm run validate:examples`）。次はロードバランサ、マネージド Postgres、DNS、インスタンスからバケットへの読み取り権限です。

## ライセンス

MIT
