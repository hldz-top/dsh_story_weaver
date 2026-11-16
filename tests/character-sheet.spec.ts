/** Character cards for e5/e6: parser, admission gate, prompt version 10, and free-text degrade. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseCharacterSheet, CharacterSheetRejection, DEFAULT_MAX_CHARACTERS } from '../src/character-sheet.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { StageValidationRejection } from '../src/stage-rejection.ts'
import { assertCharacterSheet, StageOutputSchemas } from '../src/stage-output.ts'
import { buildStagePrompt, characterDimensionsForStage, CURRENT_PROMPT_VERSION, type PromptVersion, type StagePromptKind } from '../src/stage-prompts.ts'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const promptBase = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }
const kinds = ['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity', 'continuity-snapshot'] as const satisfies readonly StagePromptKind[]
/** SHA-256 of buildStagePrompt and nativeStageOutputSchema on parent 9fa7ab4, before version 10. */
const parentHashes: Record<string, string> = {"p/1/settings":"665f40d01dc0b8663aa8a00c64abaf1013f7ffd89430d6065ffdf394e23c6c87","s/1/settings":"86f66293e41cd6e5b92d64ddf6f3a39536affacde2e0c2e4ce60a05fca94c88b","p/1/review":"8b5f910f366e95085e3157e6c72d9ac461792233d3bbc6451093b2321ec2bc90","s/1/review":"9731f7a748dd104095730772ad5cd0885a45340c865f1d7d0b75da95336c09c3","p/1/book-outline":"7100a4c61a77ddecd3e35d714e395297db81c2a1ebe052274d71bda6bc9b65e0","s/1/book-outline":"62d1e8b93ee5b030549ba85fd483fc7fa12e409a63d224ee07fe0c26fd2ce0d2","p/1/chapter-outline":"76476009a90f4448b8be4199f46249840b54cf2baf91210b00cbf8197fc81124","s/1/chapter-outline":"331f97fb15c82e27968c9d401d51070695d20fc8dcf01203facfb02b05114e20","p/1/body":"4876dcaedc3fe01c4a6da07abbe298a42cdab24456d33fa8ab21c4ca7da521bf","s/1/body":"21d5342669c4439400a3ff71b4bc16f297d262abfb823ac9f1868f57a32152f3","p/1/continuity":"a9798b274e9f7b347f476ac25dcca939a48a5fdba07185cd2c6db1d4716d3c9d","s/1/continuity":"ee4f82a9defc694c00b3c0b506310ae3ab5a998b5b9214bf291da121417b8ae0","p/1/continuity-snapshot":"f9d4a1a79f0d5826899d71d7f60673d3bb69e072e8c40788bd4f61803356d4f6","s/1/continuity-snapshot":"966e5df7933a5a53093cfe2a1b9dd79a31f78fcb19adee7847b5856fc1e54f8a","p/1/settings/enum_single":"1724c29d14ee5c2bc7460f3c2356d1e00b099671a823a1cc7f4ee4302068d78c","p/1/settings/llm_free":"665f40d01dc0b8663aa8a00c64abaf1013f7ffd89430d6065ffdf394e23c6c87","p/1/review/body":"8b5f910f366e95085e3157e6c72d9ac461792233d3bbc6451093b2321ec2bc90","p/2/settings":"665f40d01dc0b8663aa8a00c64abaf1013f7ffd89430d6065ffdf394e23c6c87","s/2/settings":"86f66293e41cd6e5b92d64ddf6f3a39536affacde2e0c2e4ce60a05fca94c88b","p/2/review":"c465e5f1f7a6dc09f66c3504c0e2efa503b0871e92cc38f1a03456d09304c87a","s/2/review":"9731f7a748dd104095730772ad5cd0885a45340c865f1d7d0b75da95336c09c3","p/2/book-outline":"7100a4c61a77ddecd3e35d714e395297db81c2a1ebe052274d71bda6bc9b65e0","s/2/book-outline":"62d1e8b93ee5b030549ba85fd483fc7fa12e409a63d224ee07fe0c26fd2ce0d2","p/2/chapter-outline":"ccc93e46f610fcd8a4aa2d63b4a8147bb832d0313833a264a8a132d52a745eaf","s/2/chapter-outline":"0285fb25e15cbfed01a7b157e83bdb5061ffeda3a999d11c6b2b69518d2f8ef5","p/2/body":"1a55937711c79268c3b83a22c6ea2ee0179c08e63ef943aaeab4a1775c682fe2","s/2/body":"21d5342669c4439400a3ff71b4bc16f297d262abfb823ac9f1868f57a32152f3","p/2/continuity":"a9798b274e9f7b347f476ac25dcca939a48a5fdba07185cd2c6db1d4716d3c9d","s/2/continuity":"ee4f82a9defc694c00b3c0b506310ae3ab5a998b5b9214bf291da121417b8ae0","p/2/continuity-snapshot":"f9d4a1a79f0d5826899d71d7f60673d3bb69e072e8c40788bd4f61803356d4f6","s/2/continuity-snapshot":"966e5df7933a5a53093cfe2a1b9dd79a31f78fcb19adee7847b5856fc1e54f8a","p/2/settings/enum_single":"1724c29d14ee5c2bc7460f3c2356d1e00b099671a823a1cc7f4ee4302068d78c","p/2/settings/llm_free":"665f40d01dc0b8663aa8a00c64abaf1013f7ffd89430d6065ffdf394e23c6c87","p/2/review/body":"c465e5f1f7a6dc09f66c3504c0e2efa503b0871e92cc38f1a03456d09304c87a","p/3/settings":"665f40d01dc0b8663aa8a00c64abaf1013f7ffd89430d6065ffdf394e23c6c87","s/3/settings":"86f66293e41cd6e5b92d64ddf6f3a39536affacde2e0c2e4ce60a05fca94c88b","p/3/review":"c465e5f1f7a6dc09f66c3504c0e2efa503b0871e92cc38f1a03456d09304c87a","s/3/review":"9731f7a748dd104095730772ad5cd0885a45340c865f1d7d0b75da95336c09c3","p/3/book-outline":"7100a4c61a77ddecd3e35d714e395297db81c2a1ebe052274d71bda6bc9b65e0","s/3/book-outline":"62d1e8b93ee5b030549ba85fd483fc7fa12e409a63d224ee07fe0c26fd2ce0d2","p/3/chapter-outline":"ccc93e46f610fcd8a4aa2d63b4a8147bb832d0313833a264a8a132d52a745eaf","s/3/chapter-outline":"0285fb25e15cbfed01a7b157e83bdb5061ffeda3a999d11c6b2b69518d2f8ef5","p/3/body":"1a55937711c79268c3b83a22c6ea2ee0179c08e63ef943aaeab4a1775c682fe2","s/3/body":"21d5342669c4439400a3ff71b4bc16f297d262abfb823ac9f1868f57a32152f3","p/3/continuity":"a9798b274e9f7b347f476ac25dcca939a48a5fdba07185cd2c6db1d4716d3c9d","s/3/continuity":"ee4f82a9defc694c00b3c0b506310ae3ab5a998b5b9214bf291da121417b8ae0","p/3/continuity-snapshot":"f9d4a1a79f0d5826899d71d7f60673d3bb69e072e8c40788bd4f61803356d4f6","s/3/continuity-snapshot":"966e5df7933a5a53093cfe2a1b9dd79a31f78fcb19adee7847b5856fc1e54f8a","p/3/settings/enum_single":"1724c29d14ee5c2bc7460f3c2356d1e00b099671a823a1cc7f4ee4302068d78c","p/3/settings/llm_free":"665f40d01dc0b8663aa8a00c64abaf1013f7ffd89430d6065ffdf394e23c6c87","p/3/review/body":"48aa58cd632cc1c1f81a984282debb8dd73b451c41e97966e278ca37745fd773","p/4/settings":"665f40d01dc0b8663aa8a00c64abaf1013f7ffd89430d6065ffdf394e23c6c87","s/4/settings":"86f66293e41cd6e5b92d64ddf6f3a39536affacde2e0c2e4ce60a05fca94c88b","p/4/review":"c465e5f1f7a6dc09f66c3504c0e2efa503b0871e92cc38f1a03456d09304c87a","s/4/review":"9731f7a748dd104095730772ad5cd0885a45340c865f1d7d0b75da95336c09c3","p/4/book-outline":"7100a4c61a77ddecd3e35d714e395297db81c2a1ebe052274d71bda6bc9b65e0","s/4/book-outline":"62d1e8b93ee5b030549ba85fd483fc7fa12e409a63d224ee07fe0c26fd2ce0d2","p/4/chapter-outline":"ccc93e46f610fcd8a4aa2d63b4a8147bb832d0313833a264a8a132d52a745eaf","s/4/chapter-outline":"0285fb25e15cbfed01a7b157e83bdb5061ffeda3a999d11c6b2b69518d2f8ef5","p/4/body":"e8ccabfe084b9f215c915a31353df9187e46f0fb33aa74a1daaf06bfb3e9a998","s/4/body":"21d5342669c4439400a3ff71b4bc16f297d262abfb823ac9f1868f57a32152f3","p/4/continuity":"a9798b274e9f7b347f476ac25dcca939a48a5fdba07185cd2c6db1d4716d3c9d","s/4/continuity":"ee4f82a9defc694c00b3c0b506310ae3ab5a998b5b9214bf291da121417b8ae0","p/4/continuity-snapshot":"f9d4a1a79f0d5826899d71d7f60673d3bb69e072e8c40788bd4f61803356d4f6","s/4/continuity-snapshot":"966e5df7933a5a53093cfe2a1b9dd79a31f78fcb19adee7847b5856fc1e54f8a","p/4/settings/enum_single":"1724c29d14ee5c2bc7460f3c2356d1e00b099671a823a1cc7f4ee4302068d78c","p/4/settings/llm_free":"665f40d01dc0b8663aa8a00c64abaf1013f7ffd89430d6065ffdf394e23c6c87","p/4/review/body":"48aa58cd632cc1c1f81a984282debb8dd73b451c41e97966e278ca37745fd773","p/5/settings":"665f40d01dc0b8663aa8a00c64abaf1013f7ffd89430d6065ffdf394e23c6c87","s/5/settings":"86f66293e41cd6e5b92d64ddf6f3a39536affacde2e0c2e4ce60a05fca94c88b","p/5/review":"c465e5f1f7a6dc09f66c3504c0e2efa503b0871e92cc38f1a03456d09304c87a","s/5/review":"9731f7a748dd104095730772ad5cd0885a45340c865f1d7d0b75da95336c09c3","p/5/book-outline":"7100a4c61a77ddecd3e35d714e395297db81c2a1ebe052274d71bda6bc9b65e0","s/5/book-outline":"62d1e8b93ee5b030549ba85fd483fc7fa12e409a63d224ee07fe0c26fd2ce0d2","p/5/chapter-outline":"ccc93e46f610fcd8a4aa2d63b4a8147bb832d0313833a264a8a132d52a745eaf","s/5/chapter-outline":"0285fb25e15cbfed01a7b157e83bdb5061ffeda3a999d11c6b2b69518d2f8ef5","p/5/body":"e8ccabfe084b9f215c915a31353df9187e46f0fb33aa74a1daaf06bfb3e9a998","s/5/body":"21d5342669c4439400a3ff71b4bc16f297d262abfb823ac9f1868f57a32152f3","p/5/continuity":"a9798b274e9f7b347f476ac25dcca939a48a5fdba07185cd2c6db1d4716d3c9d","s/5/continuity":"ee4f82a9defc694c00b3c0b506310ae3ab5a998b5b9214bf291da121417b8ae0","p/5/continuity-snapshot":"f9d4a1a79f0d5826899d71d7f60673d3bb69e072e8c40788bd4f61803356d4f6","s/5/continuity-snapshot":"966e5df7933a5a53093cfe2a1b9dd79a31f78fcb19adee7847b5856fc1e54f8a","p/5/settings/enum_single":"1724c29d14ee5c2bc7460f3c2356d1e00b099671a823a1cc7f4ee4302068d78c","p/5/settings/llm_free":"665f40d01dc0b8663aa8a00c64abaf1013f7ffd89430d6065ffdf394e23c6c87","p/5/review/body":"48aa58cd632cc1c1f81a984282debb8dd73b451c41e97966e278ca37745fd773","p/6/settings":"54a895e77a1d5558448999f5db376f653f8c6a4fbbbc50d3f8056cf57e6c4c38","s/6/settings":"86f66293e41cd6e5b92d64ddf6f3a39536affacde2e0c2e4ce60a05fca94c88b","p/6/review":"bc0210419e241c2740b1048f1713192dd6b12604bd6d8334833ef5fe2c6b0e66","s/6/review":"9731f7a748dd104095730772ad5cd0885a45340c865f1d7d0b75da95336c09c3","p/6/book-outline":"2fa3f07cc8cf3aa9d7fb40afad382dbb948762f2d341cf5820bf8da061e14c84","s/6/book-outline":"62d1e8b93ee5b030549ba85fd483fc7fa12e409a63d224ee07fe0c26fd2ce0d2","p/6/chapter-outline":"a48292975c06ea7e3642dd4021bde4c6a9a87f685f79e7ed885e3d5f397a2fed","s/6/chapter-outline":"0285fb25e15cbfed01a7b157e83bdb5061ffeda3a999d11c6b2b69518d2f8ef5","p/6/body":"59cd1fe810dc91f4383078dd7f4a9fe824363a76cae5fed6129caf8425fa569f","s/6/body":"21d5342669c4439400a3ff71b4bc16f297d262abfb823ac9f1868f57a32152f3","p/6/continuity":"d318ac5a06c7e08be4ec425a1140440b5eaa8d0aad0d1ad7d224ef798146df5c","s/6/continuity":"ee4f82a9defc694c00b3c0b506310ae3ab5a998b5b9214bf291da121417b8ae0","p/6/continuity-snapshot":"f9d4a1a79f0d5826899d71d7f60673d3bb69e072e8c40788bd4f61803356d4f6","s/6/continuity-snapshot":"966e5df7933a5a53093cfe2a1b9dd79a31f78fcb19adee7847b5856fc1e54f8a","p/6/settings/enum_single":"dda887ea1a20d7301f2f43420f426554a89c745c825291b8d7e9449ec8227f0b","p/6/settings/llm_free":"54a895e77a1d5558448999f5db376f653f8c6a4fbbbc50d3f8056cf57e6c4c38","p/6/review/body":"45f806fe583bb95066963647d51caddd89b4f72d4684e294c4ce92073faba052","p/7/settings":"54a895e77a1d5558448999f5db376f653f8c6a4fbbbc50d3f8056cf57e6c4c38","s/7/settings":"86f66293e41cd6e5b92d64ddf6f3a39536affacde2e0c2e4ce60a05fca94c88b","p/7/review":"5603ef5206e5137fb450a5267d5f4608a34cdcc8a17ace7be70294a67d45d15b","s/7/review":"f863a9302eea3f007fee5b337997cb1a71e13b965037f5447f03dee28fb0fc7a","p/7/book-outline":"2fa3f07cc8cf3aa9d7fb40afad382dbb948762f2d341cf5820bf8da061e14c84","s/7/book-outline":"a8abcb43b9d694c142126a6d93899b614561acd3baf28d3ee587320815f862e0","p/7/chapter-outline":"b24311920aa4c22cd7eb3d1c729759251974171eec13aa6dff300b3f523d95ad","s/7/chapter-outline":"1cec49044eeb285a111b2ff27e3ea0d30bd3cdb132e36cf4df78a8bf8a43c0e2","p/7/body":"59cd1fe810dc91f4383078dd7f4a9fe824363a76cae5fed6129caf8425fa569f","s/7/body":"21d5342669c4439400a3ff71b4bc16f297d262abfb823ac9f1868f57a32152f3","p/7/continuity":"d318ac5a06c7e08be4ec425a1140440b5eaa8d0aad0d1ad7d224ef798146df5c","s/7/continuity":"ee4f82a9defc694c00b3c0b506310ae3ab5a998b5b9214bf291da121417b8ae0","p/7/continuity-snapshot":"f9d4a1a79f0d5826899d71d7f60673d3bb69e072e8c40788bd4f61803356d4f6","s/7/continuity-snapshot":"966e5df7933a5a53093cfe2a1b9dd79a31f78fcb19adee7847b5856fc1e54f8a","p/7/settings/enum_single":"dda887ea1a20d7301f2f43420f426554a89c745c825291b8d7e9449ec8227f0b","p/7/settings/llm_free":"54a895e77a1d5558448999f5db376f653f8c6a4fbbbc50d3f8056cf57e6c4c38","p/7/review/body":"b214f6a9ba333d6d012e0710d06f82a480e6387b5fe81852d22062741e9ef58e","p/8/settings":"54a895e77a1d5558448999f5db376f653f8c6a4fbbbc50d3f8056cf57e6c4c38","s/8/settings":"86f66293e41cd6e5b92d64ddf6f3a39536affacde2e0c2e4ce60a05fca94c88b","p/8/review":"5b28cda1f3c8a1c6d1ef2681966af1b64af69c8952219d0939615ee72cb48c3d","s/8/review":"e76a90ebd3ee4f47f641ff188da8676ce1174abdad20acd8b6028a76631144ab","p/8/book-outline":"2fa3f07cc8cf3aa9d7fb40afad382dbb948762f2d341cf5820bf8da061e14c84","s/8/book-outline":"a8abcb43b9d694c142126a6d93899b614561acd3baf28d3ee587320815f862e0","p/8/chapter-outline":"b24311920aa4c22cd7eb3d1c729759251974171eec13aa6dff300b3f523d95ad","s/8/chapter-outline":"1cec49044eeb285a111b2ff27e3ea0d30bd3cdb132e36cf4df78a8bf8a43c0e2","p/8/body":"59cd1fe810dc91f4383078dd7f4a9fe824363a76cae5fed6129caf8425fa569f","s/8/body":"21d5342669c4439400a3ff71b4bc16f297d262abfb823ac9f1868f57a32152f3","p/8/continuity":"d318ac5a06c7e08be4ec425a1140440b5eaa8d0aad0d1ad7d224ef798146df5c","s/8/continuity":"ee4f82a9defc694c00b3c0b506310ae3ab5a998b5b9214bf291da121417b8ae0","p/8/continuity-snapshot":"f9d4a1a79f0d5826899d71d7f60673d3bb69e072e8c40788bd4f61803356d4f6","s/8/continuity-snapshot":"966e5df7933a5a53093cfe2a1b9dd79a31f78fcb19adee7847b5856fc1e54f8a","p/8/settings/enum_single":"dda887ea1a20d7301f2f43420f426554a89c745c825291b8d7e9449ec8227f0b","p/8/settings/llm_free":"54a895e77a1d5558448999f5db376f653f8c6a4fbbbc50d3f8056cf57e6c4c38","p/8/review/body":"33de65bc945935b612032d10bb3c0e38b461a43ff3876c62837c86c44241f172","p/9/settings":"54a895e77a1d5558448999f5db376f653f8c6a4fbbbc50d3f8056cf57e6c4c38","s/9/settings":"86f66293e41cd6e5b92d64ddf6f3a39536affacde2e0c2e4ce60a05fca94c88b","p/9/review":"5b28cda1f3c8a1c6d1ef2681966af1b64af69c8952219d0939615ee72cb48c3d","s/9/review":"e76a90ebd3ee4f47f641ff188da8676ce1174abdad20acd8b6028a76631144ab","p/9/book-outline":"2fa3f07cc8cf3aa9d7fb40afad382dbb948762f2d341cf5820bf8da061e14c84","s/9/book-outline":"a8abcb43b9d694c142126a6d93899b614561acd3baf28d3ee587320815f862e0","p/9/chapter-outline":"b24311920aa4c22cd7eb3d1c729759251974171eec13aa6dff300b3f523d95ad","s/9/chapter-outline":"1cec49044eeb285a111b2ff27e3ea0d30bd3cdb132e36cf4df78a8bf8a43c0e2","p/9/body":"59cd1fe810dc91f4383078dd7f4a9fe824363a76cae5fed6129caf8425fa569f","s/9/body":"21d5342669c4439400a3ff71b4bc16f297d262abfb823ac9f1868f57a32152f3","p/9/continuity":"d318ac5a06c7e08be4ec425a1140440b5eaa8d0aad0d1ad7d224ef798146df5c","s/9/continuity":"a6b9dbcb52c08c6053070c4b0b740d0b057219cafe96ca22dc7540cf645613c5","p/9/continuity-snapshot":"f9d4a1a79f0d5826899d71d7f60673d3bb69e072e8c40788bd4f61803356d4f6","s/9/continuity-snapshot":"966e5df7933a5a53093cfe2a1b9dd79a31f78fcb19adee7847b5856fc1e54f8a","p/9/settings/enum_single":"dda887ea1a20d7301f2f43420f426554a89c745c825291b8d7e9449ec8227f0b","p/9/settings/llm_free":"54a895e77a1d5558448999f5db376f653f8c6a4fbbbc50d3f8056cf57e6c4c38","p/9/review/body":"33de65bc945935b612032d10bb3c0e38b461a43ff3876c62837c86c44241f172"}

function row(name: string, frame = '技艺', chapters = '1,2'): string {
  return `| ${name} | 剑修 | 证明自己 | 被无视 | 逞强 | ${frame} | 嘴上不服 | ${chapters} |`
}
function voice(name: string): string {
  return `| ${name} | 短句，4-12 字 | 不服、试探、剑 | 前辈 | 我 | 按剑 | 当众示弱 |`
}
const coreHead = '| 角色 | 身份 | 欲望 | 恐惧 | 缺陷 | 误读框架 | 反差 | 出场章 |\n| --- | --- | --- | --- | --- | --- | --- | --- |'
const voiceHead = '| 角色 | 句式 | 专属词 | 称呼主角 | 自称 | 身体签 | 禁语 |\n| --- | --- | --- | --- | --- | --- | --- |'
function sheet(names: readonly { name: string; frame?: string; chapters?: string }[]): string {
  return [coreHead, ...names.map(item => row(item.name, item.frame, item.chapters)), '', voiceHead, ...names.map(item => voice(item.name))].join('\n')
}
const three = sheet([
  { name: '云望舒', frame: '利益', chapters: '1,2,3' },
  { name: '苏清鸢', frame: '其它:怕输', chapters: '2' },
  { name: '沈丹青', frame: '礼法', chapters: '4' },
])

function messageOf(markdown: string, options?: { maxCharacters?: number }): string {
  try { parseCharacterSheet(markdown, options ?? {}) }
  catch (cause) {
    expect(cause).toBeInstanceOf(StageValidationRejection)
    expect(cause).toBeInstanceOf(CharacterSheetRejection)
    return (cause as Error).message
  }
  throw new Error('expected a character-sheet rejection')
}

describe('parseCharacterSheet', () => {
  it('parses three characters from the double table', () => {
    const parsed = parseCharacterSheet(three)
    expect(parsed.core.map(item => item.name)).toEqual(['云望舒', '苏清鸢', '沈丹青'])
    expect(parsed.voice.map(item => item.name)).toEqual(['云望舒', '苏清鸢', '沈丹青'])
    expect(parsed.core[0]).toMatchObject({ role: '剑修', want: '证明自己', fear: '被无视', flaw: '逞强', misread: '利益', contrast: '嘴上不服', chapters: [1, 2, 3] })
    expect(parsed.core[1]?.misread).toBe('其它:怕输')
    expect(parsed.voice[2]).toMatchObject({ lexicon: ['不服', '试探', '剑'], addressForProtagonist: '前辈', selfReference: '我', mannerism: '按剑', forbidden: '当众示弱' })
  })

  it('rejects a missing table and names the character', () => {
    const markdown = `${voiceHead}\n${voice('苏清鸢')}`
    const message = messageOf(markdown)
    expect(message).toContain('苏清鸢')
    expect(message).toContain('内核表')
    expect(message).toContain('角色, 身份, 欲望, 恐惧, 缺陷, 误读框架, 反差, 出场章')
  })

  it('rejects a wrong column count and names the character', () => {
    const markdown = [
      '| 角色 | 身份 | 欲望 | 恐惧 | 缺陷 | 误读框架 | 反差 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| 苏清鸢 | 剑修 | 证明自己 | 被无视 | 逞强 | 技艺 | 嘴上不服 |',
      '',
      voiceHead,
      voice('苏清鸢'),
    ].join('\n')
    const message = messageOf(markdown)
    expect(message).toContain('苏清鸢')
    expect(message).toContain('7')
    expect(message).toContain('8')
    expect(message).toContain('出场章')
  })

  it('rejects characters that do not match between the tables and names them', () => {
    const markdown = [coreHead, row('云望舒'), row('沈丹青'), '', voiceHead, voice('云望舒'), voice('苏清鸢')].join('\n')
    const message = messageOf(markdown)
    expect(message).toContain('沈丹青')
    expect(message).toContain('苏清鸢')
    expect(message).toContain('内核表')
    expect(message).toContain('声纹表')
  })

  it('rejects a duplicate name and names that character', () => {
    const markdown = [coreHead, row('云望舒'), row('云望舒'), '', voiceHead, voice('云望舒')].join('\n')
    const message = messageOf(markdown)
    expect(message).toContain('云望舒')
    expect(message).toContain('duplicated')
    expect(message).toContain('内核表')
  })

  it('rejects an illegal misread frame and names the character and field', () => {
    const message = messageOf(sheet([{ name: '苏清鸢', frame: '命运' }]))
    expect(message).toContain('苏清鸢')
    expect(message).toContain('误读框架')
    expect(message).toContain('命运')
    expect(message).toContain('利益')
    expect(message).toContain('其它:')
  })

  it('rejects an illegal chapter number and names the character and field', () => {
    const message = messageOf(sheet([{ name: '苏清鸢', chapters: '1,二' }]))
    expect(message).toContain('苏清鸢')
    expect(message).toContain('出场章')
    expect(message).toContain('二')
    expect(message).toContain('1,2,3')
  })

  it('rejects more than 12 characters and says to split them across e5 and e6', () => {
    const names = Array.from({ length: 13 }, (_, index) => ({ name: `配角${index + 1}` }))
    const message = messageOf(sheet(names))
    expect(message).toContain('13')
    expect(message).toContain(String(DEFAULT_MAX_CHARACTERS))
    expect(message).toContain('e5')
    expect(message).toContain('e6')
    expect(message).toContain('配角1')
  })

  it('names a blank field on that character', () => {
    const markdown = [coreHead, '| 苏清鸢 | 剑修 |  | 被无视 | 逞强 | 技艺 | 嘴上不服 | 1 |', '', voiceHead, voice('苏清鸢')].join('\n')
    const message = messageOf(markdown)
    expect(message).toContain('苏清鸢')
    expect(message).toContain('欲望')
  })
})

describe('assertCharacterSheet', () => {
  it('parses e5 and e6 on version 10 and skips every other case', () => {
    expect(() => assertCharacterSheet('e5', three, { promptVersion: 10 })).not.toThrow()
    expect(() => assertCharacterSheet('e6', three)).not.toThrow()
    expect(() => assertCharacterSheet('a1', 'not a table')).not.toThrow()
    expect(() => assertCharacterSheet('e5', 'not a table', { promptVersion: 9 })).not.toThrow()
    expect(() => assertCharacterSheet('e6', 'not a table', { characterSheet: false, promptVersion: 10 })).not.toThrow()
    expect(() => assertCharacterSheet('e5', 'not a table', { promptVersion: 10 })).toThrow(CharacterSheetRejection)
  })

  it('leaves the settings schema and the continuity snapshot unchanged', () => {
    expect(Object.keys(StageOutputSchemas.settings.shape)).toEqual(['version', 'inputRefs', 'dimensionCode', 'facts', 'contentMarkdown'])
    const snapshot = JSON.stringify(nativeStageOutputSchema('continuity-snapshot', 10))
    expect(snapshot).not.toContain('name_note')
    expect(snapshot).toBe(JSON.stringify(nativeStageOutputSchema('continuity-snapshot', 9)))
    for (const kind of kinds) expect(JSON.stringify(nativeStageOutputSchema(kind, 10)), kind).toBe(JSON.stringify(nativeStageOutputSchema(kind, 9)))
  })
})

describe('prompt version 10', () => {
  it('replays versions 1–9 prompt and schema bytes from parent 9fa7ab4', () => {
    expect(CURRENT_PROMPT_VERSION).toBe(12)
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const satisfies readonly PromptVersion[]) {
      for (const kind of kinds) {
        expect(sha(buildStagePrompt({ ...promptBase, kind, promptVersion: version })), `p/${version}/${kind}`).toBe(parentHashes[`p/${version}/${kind}`])
        expect(sha(JSON.stringify(nativeStageOutputSchema(kind, version))), `s/${version}/${kind}`).toBe(parentHashes[`s/${version}/${kind}`])
      }
      expect(sha(buildStagePrompt({ ...promptBase, kind: 'settings', settingsDimensionKind: 'enum_single', promptVersion: version }))).toBe(parentHashes[`p/${version}/settings/enum_single`])
      expect(sha(buildStagePrompt({ ...promptBase, kind: 'settings', settingsDimensionKind: 'llm_free', promptVersion: version }))).toBe(parentHashes[`p/${version}/settings/llm_free`])
      expect(sha(buildStagePrompt({ ...promptBase, kind: 'review', reviewedKind: 'body', promptVersion: version }))).toBe(parentHashes[`p/${version}/review/body`])
      const forced = buildStagePrompt({ ...promptBase, kind: 'settings', promptVersion: version, characterDimensions: ['e5', 'e6'], maxCharacters: 4 })
      expect(forced, String(version)).toBe(buildStagePrompt({ ...promptBase, kind: 'settings', promptVersion: version }))
    }
  })

  it('adds the double-table instruction only for version 10 e5/e6 settings', () => {
    for (const kind of kinds) {
      expect(buildStagePrompt({ ...promptBase, kind, promptVersion: 10 }), kind).toBe(buildStagePrompt({ ...promptBase, kind, promptVersion: 9 }))
    }
    const e5 = buildStagePrompt({ ...promptBase, kind: 'settings', promptVersion: 10, characterDimensions: ['e5'], maxCharacters: 12 })
    expect(e5).toContain('e5 助攻角色')
    expect(e5).toContain('角色, 身份, 欲望, 恐惧, 缺陷, 误读框架, 反差, 出场章')
    expect(e5).toContain('角色, 句式, 专属词, 称呼主角, 自称, 身体签, 禁语')
    expect(e5).toContain('利益')
    expect(e5).toContain('其它:')
    expect(e5).toContain('at most 12')
    expect(buildStagePrompt({ ...promptBase, kind: 'settings', promptVersion: 9, characterDimensions: ['e5'] })).not.toContain('误读框架')
    expect(characterDimensionsForStage({ dimensionCode: 'e5', codes: ['e6', 'a1'] })).toEqual(['e5', 'e6'])
    expect(characterDimensionsForStage({ dimensionCode: 'a1' })).toEqual([])
  })
})

function withE5Body(stage: WritingFixtureStage, output: object, body: string): object {
  if (stage.kind !== 'settings' || (stage.task?.batch !== 'draft' && stage.task?.batch !== 'repair')) return output
  const batch = output as { dimensions?: { code: string; body: string }[] }
  if (!Array.isArray(batch.dimensions)) return output
  return { ...batch, dimensions: batch.dimensions.map(item => item.code === 'e5' ? { code: item.code, body } : item) }
}

const voiceOnly = `${voiceHead}\n${voice('苏清鸢')}`

async function writeE5(body: string, options: { characterSheet?: boolean; maxRepairAttempts?: number } = {}) {
  const fixture = await useWritingFixture({
    ...(options.characterSheet === undefined ? {} : { characterSheet: options.characterSheet }),
    executionLimits: { researchEnabled: false, maxRepairAttempts: options.maxRepairAttempts ?? 1 },
    intervene: (stage, output) => withE5Body(stage, output, body),
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['e5'], chapterCount: 1, throughChapter: 1 }))
  return { fixture, outcome }
}

describe('e5 admission', () => {
  it('sends a named rejection back for repair, then keeps the prose when the card still fails', async () => {
    const { fixture, outcome } = await writeE5(voiceOnly)
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.status).toBe('completed')
    expect(outcome.value.executionLimits).not.toHaveProperty('characterSheet')
    expect(outcome.value.executionLimits).not.toHaveProperty('maxCharacters')
    const repair = [...fixture.stages.values()].find(stage => stage.kind === 'settings' && stage.task?.validationError != null)
    expect(repair?.task?.validationError).toContain('苏清鸢')
    expect(repair?.task?.validationError).toContain('内核表')
    expect(repair?.prompt).toContain('误读框架')
    const applied = fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.find(item => item.dimensionCode === 'e5')
    expect(applied).toBeDefined()
    const stored = JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: applied!.artifact.id }).text) as { contentMarkdown: string }
    expect(Object.keys(stored).sort()).toEqual(['contentMarkdown', 'dimensionCode', 'facts', 'inputRefs', 'version'])
    expect(stored.contentMarkdown).toBe(voiceOnly)
    expect(() => parseCharacterSheet(stored.contentMarkdown)).toThrow(CharacterSheetRejection)
  }, 120_000)

  it('keeps e5 free text, with the version-9 prompt, when characterSheet is false', async () => {
    const { fixture, outcome } = await writeE5(voiceOnly, { characterSheet: false, maxRepairAttempts: 0 })
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.status).toBe('completed')
    expect(outcome.value.promptVersion).toBe(12)
    const settings = [...fixture.stages.values()].filter(stage => stage.kind === 'settings' && stage.task?.batch === 'draft')
    expect(settings.length).toBeGreaterThan(0)
    for (const stage of settings) {
      expect(stage.task?.validationError ?? null).toBeNull()
      expect(stage.prompt).not.toContain('误读框架')
      expect(stage.prompt).not.toContain('声纹表')
    }
    expect([...fixture.stages.values()].some(stage => stage.kind === 'settings' && stage.task?.batch === 'repair')).toBe(false)
    const applied = fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.find(item => item.dimensionCode === 'e5')
    const stored = JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: applied!.artifact.id }).text) as { contentMarkdown: string }
    expect(stored.contentMarkdown).toBe(voiceOnly)
  }, 120_000)

  it('admits a valid card without a character-sheet repair', async () => {
    const { fixture, outcome } = await writeE5(three, { maxRepairAttempts: 1 })
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.status).toBe('completed')
    const drafts = [...fixture.stages.values()].filter(stage => stage.kind === 'settings' && (stage.task?.batch === 'draft' || stage.task?.batch === 'repair'))
    expect(drafts.some(stage => stage.prompt.includes('误读框架'))).toBe(true)
    expect(drafts.every(stage => stage.task?.validationError == null || !stage.task.validationError.includes('内核表'))).toBe(true)
    const applied = fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.find(item => item.dimensionCode === 'e5')
    const stored = JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: applied!.artifact.id }).text) as { contentMarkdown: string }
    expect(parseCharacterSheet(stored.contentMarkdown).core).toHaveLength(3)
  }, 120_000)
})
