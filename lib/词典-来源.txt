本目录下的「词典.txt」不是本项目原创，它来自 jieba 中文分词项目：

    https://github.com/fxsjy/jieba

原文件是 jieba 的 extra_dict/dict.txt.small（README 里称「占用内存较小的词典」）。
本插件只保留其中的**词条本身**，去掉了原来的词频和词性两列（本插件不用那两列）。

--------------------------------------------------------------------------

本目录下的「词频.txt」跟「词典.txt」**来自同一个文件**，也是 jieba 的
extra_dict/dict.txt.small。区别是它**用回了原来被丢掉的那一列「词频」**。

它记的是「这个词在通用中文里有多常见」——跟谁在用、说过什么话都无关。
插件拿它做一件事：**最常用的那些中文词，不当检索线索**。

每行格式是「词 两位数字」：

    词    通用中文里的常见程度，0 = 最常用，99 = 很具体（越少见数字越大）

算法（生成脚本里就这几行，可复现）：

    稀有度 = 1 - log10(词频 + 1) / log10(最大词频 + 1)     → 0 ~ 1
    数字   = round(稀有度 × 99)

只收通用中文里**最常见的前 20000 个词**；更靠后的词一律当「很具体」，
所以查不到就等于 99，不必全收进来（省体积）。

--------------------------------------------------------------------------

jieba 采用 MIT 授权协议。按协议要求，原样附上版权声明：

--------------------------------------------------------------------------
The MIT License (MIT)

Copyright (c) 2013 Sun Junyi

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
--------------------------------------------------------------------------
