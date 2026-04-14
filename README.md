# STUN-Panel

利用Cloudflare Workers实现的Lucky STUN 内网穿透动态端口自动跳转,带监控大屏

# 使用教程

`本教程只适用于已搭建好端口穿透的用户，关于如何端口穿透，请另寻教程，如：
[STUN内网穿透 | Lucky开发分享](https://www.lucky666.cn/docs/modules/stun/)
`在部署或使用的过程中出现任何问题，都可以向AI求助，求助时，请附带完整的日志或对问题详细的描述

### 第一步：部署 Cloudflare Worker

点击一键部署：
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/i5114514kf/STUN-Panel)
Select KV 命名空间选择`新建`
点击`创建和部署`
### 第二步：绑定自定义域名

由于workers.dev域名被墙,所以这里建议绑定自定义域名并优选,具体可查看二叉树树的教程:
[试试Cloudflare IP优选！让Cloudflare在国内再也不是减速器！ - 《二叉树树》官方网站](https://2x.nz/posts/cf-fastip/)

### 第三步：配置 Lucky Webhook 上报

现在您需要让您的 Lucky 客户端将节点信息推送到这个导航页。

进入 Lucky 后台→内网穿透→STUN内网穿透→设置→启用全局Stun Webhook，填写配置：
    **接口地址**填写： `https://你的域名/?key=123456&name=#{ruleName}&addr=#{ip}:#{port}`
    **请求方法选择**：`GET`
    **请求头**留空不填
    **重试次数**可适当增加
    **接口调用成功包含的字符串**填：`Update Success`
    _注意：`key` 必须与代码中第8行的校验码一致（默认 123456），可自行更改

### 第四步：使用

- **访问导航页**：直接访问 `https://你的域名/` 即可看到所有上报的节点。

- **快捷跳转**：访问 `https://你的域名/节点名称` 会直接重定向到该节点的实时 IP 地址。