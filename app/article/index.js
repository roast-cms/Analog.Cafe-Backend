const express = require('express')
const count = require('word-count')
const moment = require('moment')
const Article = require('../../models/mongo/article')
const User = require('../../models/mongo/user.js')
const multipart = require('connect-multiparty')
const articleFeed = require('./article-feed')
const redisClient = require('../../helpers/redis')
const Submission = require('../../models/mongo/submission')
const { authenticationMiddleware } = require('../../helpers/authenticate')
const {
  parseContent,
  parseHeader,
  rawImageCount,
  uploadImgAsync,
  summarize
} = require('../../helpers/submission')
const { imageFroth } = require('../../helpers/image_froth')
const uploadRSSAndSitemap = require('../../upload_rss_sitemap')
const multipartMiddleware = multipart()
const articleApp = express()

/**
 * @swagger
 * /list:
 *   get:
 *     description: Active user account if code is correct and code is not expired.
 *     parameters:
 *            - name: tag
 *              in: query
 *              schema:
 *                type: string
 *              description: Filter by tag ex. photo-essay:editorial
 *            - name: author
 *              in: query
 *              schema:
 *                type: string
 *              description: Filter by author id.
 *            - name: page
 *              in: query
 *              schema:
 *                type: integer
 *              description: Current page number.
 *            - name: items-per-page
 *              in: query
 *              schema:
 *                type: integer
 *              description: Number of items per one page.
 *            - name: authorship
 *              in: query
 *              schema:
 *                type: string
 *                enum: [solo, collaboration]
 *              description: Filter articles by authorship type
 *     responses:
 *       200:
 *         description: Return list of published articles.
 *       404:
 *         description: Author not found.
 */

/**
 * /articles:
 *   $ref: '#/paths/~1list
 */
articleApp.get(['/articles', '/list'], async (req, res) => {
  const featured = req.query.featured
  const tags = (req.query.tag && req.query.tag.split(':')) || []
  const authorId = req.query.author
  const page = req.query.page || 1
  const itemsPerPage = parseInt(req.query['items-per-page']) || 10
  const authorshipType = req.query.authorship

  let queries = [Article.find(), Article.find()]
  queries.map(q => q.find({ status: 'published' }))
  if (tags && tags.length !== 0) {
    queries.map(q => q.where('tag').in(tags))
  }

  // by default we're sorting by date published
  let sortBy = 'date.published'

  // if featured value in parameters, fin all articles with `featured` tag that exists and not false
  if (featured) {
    queries.map(q =>
      q.find({ featured: { $exists: true, $ne: null, $ne: '0' } })
    )

    // featured items are sorted by date featured
    // `featured` field should have unix date
    sortBy = 'featured'
  }

  let author
  if (authorId) {
    author = await User.findOne({ id: authorId }).exec()
    if (!author) {
      return res.status(404).json({ message: 'Author not found' })
    }
    queries.map(q => q.find({ authors: { $elemMatch: { id: authorId } } }))
  }
  if (authorshipType) {
    queries.map(q =>
      q.find({ 'authors.1': { $exists: authorshipType === 'collaboration' } })
    )
  }

  let [query, countQuery] = queries

  query
    .select(
      'id slug title subtitle stats submittedBy authors poster tag featured status summary date'
    )
    .limit(itemsPerPage)
    .skip(itemsPerPage * (page - 1))
    // features are sorted asc, with lowest numbers at the top,
    // if sorted by date, descending (highest numbers at the top)
    .sort({ [sortBy]: featured ? 'asc' : 'desc' })

  const articles = await query.exec()
  const count = await countQuery.count().exec()

  res.json({
    status: 'ok',
    filter: {
      tags: tags,
      featured: featured,
      author: authorId
        ? { id: authorId, name: (author && author.title) || '' }
        : undefined
    },
    page: {
      current: page,
      total: Math.ceil(count / itemsPerPage),
      'items-total': count,
      'items-per-page': itemsPerPage
    },
    items: articles
  })
})

/**
 * @swagger
 * /rss:
 *   get:
 *     description: Get RSS feeds.
 *     responses:
 *       200:
 *         description: Return RSS feeds xml.
 */
articleApp.get('/rss', async (req, res) => {
  const query = Article.find({ status: 'published' })
    .select(
      'id slug title subtitle stats submittedBy authors poster tag status summary date'
    )
    .limit(30)
    .sort({ 'date.published': 'desc' })
  const articles = await query.exec()
  articleFeed.items = []
  articles.forEach(a => {
    const url = `https://www.analog.cafe/zine/${a.slug}`
    const image = a.poster && imageFroth({ src: a.poster })

    // smarter name joiner with punctuation
    const authorNameList = authors => {
      let compiledNameList = ''
      if (authors.length === 1) {
        compiledNameList = authors[0]
      } else if (authors.length === 2) {
        // joins all with "and" but no commas
        // example: "bob and sam"
        compiledNameList = authors.join(' and ')
      } else if (authors.length > 2) {
        // joins all with commas, but last one gets ", and" (oxford comma!)
        // example: "bob, joe, and sam"
        compiledNameList =
          authors.slice(0, -1).join(', ') + ', and ' + authors.slice(-1)
      }
      return compiledNameList
    }

    // do not add downloads to RSS list
    if (a.tag === 'download') return

    articleFeed.item({
      title:
        a.title +
        (a.subtitle
          ? `${!a.title[a.title.length - 1].match(/[.,!?:…*ʔっ)]/g)
              ? ':'
              : ''} ${a.subtitle}`
          : ''),
      url: url,
      guid: url,
      description:
        (image && image.src
          ? `<p><img src="${image.src}" alt="" class="webfeedsFeaturedVisual" width="600" height="auto" /></p>`
          : '') + `<p>${a.summary}</p>`,
      author: authorNameList(
        a.authors.map(author => author.name.split(' ')[0])
      ),
      date: moment.unix(a.date.published).toDate().toString(),
      categories: [a.tag],
      enclosure: { url: image && image.src }
    })
  })
  res.type('text/xml')
  res.send(articleFeed.xml())
})

/**
 * @swagger
 * /articles/:articleSlug:
 *   get:
 *     description: Get article by slug.
 *     parameters:
 *            - name: articleSlug
 *              in: path
 *              schema:
 *                type: string
 *                description: Article's slug
 *                required: true
 *     responses:
 *       200:
 *         description: Return article.
 *       404:
 *         description: Article not found.
 */
articleApp.get('/articles/:articleSlug', async (req, res) => {
  const article = await Article.findOne({
    slug: req.params.articleSlug,
    status: 'published'
  })
  if (!article) {
    return res.status(404).json({
      message: 'Article not found'
    })
  }

  // get full data on all included authors
  const authorIdQueries = article.authors.map(author => {
    return { id: author.id }
  })
  const authorObjects = await User.find({ $or: authorIdQueries })

  // complete article author objects with extended data on authors
  const completeAuthorObjects = authorObjects.map(author => {
    const { id, title, image, text, buttons, role } = author
    const authorship = article.authors.filter(author => author.id === id)[0]
      .authorship
    return { id, title, image, text, buttons, role, authorship }
  })

  // include authors who are not in the database in author list
  const missingAuthorObjects = article.authors.filter(author => {
    isComplete =
      typeof completeAuthorObjects.filter(
        completeAuthor => author.id === completeAuthor.id
      )[0] !== 'undefined'
    return !isComplete
  })
  const missingAuthorObjectsNormalizedVarNames = missingAuthorObjects.map(
    author => {
      return {
        id: author.id,
        title: author.name || author.title,
        authorship: author.authorship
      }
    }
  )

  // find next article info
  const nextArticle = await Article.findOne({
    'date.published': { $lt: article.date.published },
    status: 'published'
  })
    .sort({ 'date.published': 'desc' })
    .exec()

  res.json({
    ...article.toObject(),
    authors: [
      ...completeAuthorObjects,
      ...missingAuthorObjectsNormalizedVarNames
    ],
    next: {
      slug: (nextArticle && nextArticle.slug) || undefined,
      title: (nextArticle && nextArticle.title) || undefined,
      authors: (nextArticle && nextArticle.authors) || undefined,
      subtitle: (nextArticle && nextArticle.subtitle) || undefined,
      tag: (nextArticle && nextArticle.tag) || undefined,
      poster: (nextArticle && nextArticle.poster) || undefined
    }
  })
})

/**
  * @swagger
  * /articles/:articleId:
  *   put:
  *     description: Prep article for update - data needs to be uploaded this way into the submission (sets submission status to pending, which will need to be approved again)
  *     parameters:
  *            - name: Authorization
  *              in: header
  *              schema:
  *                type: string
  *                required: true
  *                description: JWT access token for verification user ex. "JWT eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImFraXlhaGlrIiwiaWF0IjoxNTA3MDE5NzY3fQ.MyAieVFDGAECA3yH5p2t-gLGZVjTfoc15KJyzZ6p37c"
  *            - name: articleId
  *              in: path
  *              schema:
  *                type: string
  *                required: true
  *                description: Article id.
  *            - name: status
  *              in: query
  *              schema:
  *                type: string
  *                required: true
  *                description: Submission status.
  *            - name: tag
  *              in: query
  *              schema:
  *                type: string
  *                required: true
  *                description: Submission tag.
  *            - name: header
  *              in: query
  *              schema:
  *                type: object
  *                properties:
  *                  title:
  *                    type: string
  *                    required: true
  *                  subtitle:
  *                    type: string
  *              required: true
  *              description: Article header
  *            - name: content.
  *              in: query
  *              schema:
  *                type: object
  *                properties:
  *                  kind:
  *                    type: string
  *                  document:
  *                    type: object
  *                    properties:
  *                      kind:
  *                        type: string
  *                      nodes:
  *                        type: array
  *                        items:
  *                          type: object
  *                          properties:
  *                            type:
  *                              type: string
  *                            isVoid:
  *                              type: boolean
  *                            kind:
  *                              type: string
  *                            data:
  *                              type: object
  *                              properties:
  *                                src:
  *                                  type: string
  *                            nodes:
  *                              type: array
  *                              items:
  *                                type: object
  *                                properties:
  *                                  kind:
  *                                    type: string
  *                                  ranges:
  *                                    type: array
  *                                    items:
  *                                      type: object
  *                                      properties:
  *                                        text:
  *                                          type: string
  *                                          description: Article subtitle
  *                                        kind:
  *                                          type: string
  *                                        marks:
  *                                          type: array
  *              description:  Submission body
  *     responses:
  *       200:
  *         description: Created submission for the article.
  *       401:
  *         description: No permission to access.
  *       404:
  *         description: Article not found.
  *       422:
  *         description: Article can not be edited.
  */
articleApp.put(
  '/articles/:articleId',
  multipartMiddleware,
  authenticationMiddleware,
  async (req, res) => {
    let article = await Article.findOne({ id: req.params.articleId })
    if (!article) {
      return res.status(404).json({ message: 'Article not found' })
    }
    if (req.user.role !== 'admin' && req.user.id !== article.submittedBy.id) {
      return res.status(401).json({ message: 'No permission to access' })
    }

    const content = parseContent(req.body.content)
    const header = parseHeader(req.body.header)
    const textContent = req.body.textContent
    const tag = req.body.tag

    let submission = await Submission.findOne({ articleId: article.id })
    if (!submission) {
      submission = new Submission({
        ...article.toObject(),
        articleId: article.id
      })
      submission = await submission.save()
    }
    submission.title = header.title
    submission.subtitle = header.subtitle
    submission.stats = {
      images: rawImageCount(content),
      words: count(textContent)
    }
    submission.summary = summarize(textContent)
    submission.content = { raw: content }
    submission.status = req.body.status || 'pending'
    submission.tag = tag || article.tag

    submission = await submission.save()
    redisClient.set(`${submission.id}_upload_progress`, '0')
    uploadImgAsync(req, res, submission.id)
    res.json(submission.toObject())
  }
)

/**
  * @swagger
  * /articles/:articleId:
  *   delete:
  *     description: Unpublish article
  *     parameters:
  *            - name: Authorization
  *              in: header
  *              schema:
  *                type: string
  *                required: true
  *                description: JWT access token for verification user ex. "JWT eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImFraXlhaGlrIiwiaWF0IjoxNTA3MDE5NzY3fQ.MyAieVFDGAECA3yH5p2t-gLGZVjTfoc15KJyzZ6p37c"
  *            - name: articleId
  *              in: path
  *              schema:
  *                type: string
  *                required: true
  *                description: article id.
  *     responses:
  *       200:
  *         description: Deleted article.
  *       401:
  *         description: No permission to access.
  *       404:
  *         description: Article not found.
  *       422:
  *         description: Article can not be deleted.
  */
articleApp.delete(
  '/articles/:articleId',
  authenticationMiddleware,
  async (req, res) => {
    let article = await Article.findOne({
      id: req.params.articleId
    })
    let submission = await Submission.findOne({ articleId: article.id })
    if (!submission) {
      submission = new Submission({
        ...article.toObject(),
        articleId: article.id
      })
      submission = await submission.save()
    }

    if (req.user.role !== 'admin') {
      return res.status(401).json({ message: 'No permission to access' })
    }
    if (!article) {
      return res.status(404).json({ message: 'Article not found' })
    }

    article.status = 'unpublished'
    submission.status = 'unpublished'

    article = await article.save()
    if (!article) {
      return res.status(422).json({ message: 'Article can not be edited' })
    }

    submission = await submission.save()
    if (!submission) {
      return res
        .status(422)
        .json({ message: 'Linked submission record can not be edited' })
    }

    res.status(200).json({ message: 'Article has been unpublished' })
    if (process.env.API_DOMAIN_PROD === process.env.API_DOMAIN) {
      uploadRSSAndSitemap(
        process.env.API_DOMAIN,
        true,
        null,
        process.env.S3_BUCKET
      )
    }
  }
)

module.exports = articleApp
