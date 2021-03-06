'use strict'

// Number of comments shown in a "page", aka the max number of comments which
// can be fetched in a single request.
const PAGE_LENGTH = 40

const cheerio = require('cheerio')
const fetch = require('node-fetch')
const profiles = require('./profiles')
const util = require('./util')

module.exports.browse = async function({rl, us, pageType, pageId, pageObj = null, jumpTo = null, commentsEnabled = true}) {
  let currentPageNumber = 1

  if (commentsEnabled) {
    console.log(
      `\x1b[1mYou will leave comments as \x1b[34;1m${us.username}\x1b[0;1m.\x1b[0m`)
  } else {
    console.log(
      '\x1b[31mSending new comments has been disabled here, but you can browse existing ones.\x1b[0m')
  }

  if (jumpTo) {
    process.stdout.write(`Finding comment ${jumpTo}...`)
  }

  let currentComment = null, comments = []
  let noMoreComments = false, quit = false

  const jumpToComment = async function(id) {
    // Try to find the comment from what we already have loaded
    // (if anything)...
    const c = findComment(comments, id)
    if (c) {
      currentComment = c
    } else {
      // If it's not found immediately, search for it.

      process.stdout.write(`Finding comment ${id}...`)

      const { comments, jumpedComment, pageNum } = await fetchComments(
        pageType, pageId, currentPageNumber, id
      )

      comments.push(...comments)
      setupNextPreviousLinks(comments)
      currentPageNumber = pageNum

      if (jumpedComment) {
        console.log('Found!')
        currentComment = jumpedComment
      } else {
        console.log(' Comment not found, sorry.')
        if (!currentComment) {
          currentComment = comments[0]
        }
      }
    }
  }

  if (jumpTo) {
    await jumpToComment(jumpTo)
  } else {
    comments = (await fetchComments(pageType, pageId, 1)).comments
    currentComment = comments[0]
  }

  // Same logic as in "load more comments" - if there are less than
  // PAGE_LENGTH comments fetched, then we have definitely fetched them
  // all.
  if (comments.length < PAGE_LENGTH) {
    noMoreComments = true
  }

  while (!quit) {
    if (currentComment) {
      const { author, content, date, replies, id } = currentComment
      console.log(`\x1b[2m${date}  (ID: ${id})\x1b[0m`)
      console.log(`\x1b[34;1m${author}\x1b[0m: ${content}`)

      if (replies) {
        const len = replies.length
        if (len) {
          console.log(`\x1b[2m${len} repl${len === 1 ? 'y' : 'ies'}\x1b[0m`)
        }
      }
    } else {
      console.log('There are no comments here, yet.')
    }

    const commentsDisabledChoice = {
      invisible: true,
      action: async () => {
        console.log('\x1b[31mSorry, commenting is disabled here.\x1b[0m')
        await util.delay()
      }
    }

    const cc = currentComment
    await util.choose({rl, us}, {
      q: {
        help: 'Quit browsing comments.',
        longcodes: ['quit', 'back'],
        action: () => {
          quit = true
        }
      },

      w: (us && !(cc && cc.parent)) ? commentsEnabled ? {
        help: 'Write a new comment, to be sent to the top of this comment section.',
        longcodes: ['write', 'new'],
        action: async () => {
          const comment = await commentPrompt({
            rl, us, pageType, pageId,
            promptStr: `Comment, as ${us.username}: `
          })

          if (comment) {
            console.log('Sent.')
            comments.unshift(comment)
            setupNextPreviousLinks(comments)
            currentComment = comment
          }
        }
      } : commentsDisabledChoice : undefined,

      n: (cc && cc.next) ? {
        help: 'View next comment.',
        longcodes: ['next'],
        action: () => {
          currentComment = currentComment.next
        }
      } : undefined,

      p: (cc && cc.previous) ? {
        help: 'View previous comment.',
        longcodes: ['prev', 'previous'],
        action: () => {
          currentComment = currentComment.previous
        }
      } : undefined,

      i: (cc && cc.replies && cc.replies.length) ? {
        help: 'View replies.',
        longcodes: ['in', 'replies'],
        action: () => {
          currentComment = currentComment.replies[0]
        }
      } : undefined,

      I: (cc && cc.replies && cc.replies.length > 1) ? {
        help: 'View the most recent reply.',
        longcodes: ['last', 'lastreply'],
        action: () => {
          currentComment = currentComment.replies[currentComment.replies.length - 1]
        }
      } : undefined,

      o: (cc && cc.parent) ? {
        help: 'Go out of this reply thread.',
        longcodes: ['out', 'top'],
        action: () => {
          currentComment = currentComment.parent
        }
      } : undefined,

      a: cc ? {
        help: `Browse the profile of this user, \x1b[34;1m${currentComment.author}\x1b[0m.`,
        longcodes: ['author', 'profile'],
        action: async () => {
          await profiles.browse({rl, us, username: currentComment.author})
        }
      } : undefined,

      m: !noMoreComments ? {
        help: 'Load more comments.',
        longcodes: ['more'],
        action: async () => {
          const { comments: newComments } = await fetchComments(pageType, pageId, ++currentPageNumber)
          if (newComments.length) {
            comments.push(...newComments)
            setupNextPreviousLinks(comments)
            currentComment = newComments[0]

            // If there are less than PAGE_LENGTH comments returned, we have
            // definitely fetched all the comments. This isn't able to detect
            // the case of there being an exact multiple of PAGE_LENGTH
            // comments in total, but that's relatively rare (1/PAGE_LENGTH
            // probability), and is handled by the below "else".
            if (newComments.length < PAGE_LENGTH) {
              noMoreComments = true
            }
          } else {
            console.log('There are no more comments.')
            noMoreComments = true
          }
        }
      } : undefined,

      j: {
        help: 'Jump to a comment by its ID.',
        longcodes: ['jump'],
        action: async () => {
          const id = await util.prompt(rl, 'Comment ID: ')
          if (id) {
            await jumpToComment(id)
          }
        }
      },

      d: (us && cc && (
        (pageType === 'gallery' && cc.author === us.username && pageObj.areWeAnOwner) ||
        (pageType === 'user' && pageId === us.username) ||
        (pageType === 'project' && pageObj.author === us.username)
      )) ? {
        help: 'Delete this comment.',
        longcodes: ['delete', 'remove'],
        action: async () => {
          if (await util.confirm(rl, `Really delete "${currentComment.content}"? `)) {
            await fetch(`${util.urls.siteAPI}/comments/${pageType}/${pageId}/del/`, {
              method: 'POST',
              body: JSON.stringify({id: currentComment.id}),
              headers: util.makeFetchHeaders(us)
            })

            if (currentComment.parent) {
              const index = cc.parent.replies.indexOf(cc)
              cc.parent.replies.splice(index, 1)
              setupNextPreviousLinks(currentComment.parent)
              currentComment = cc.parent.replies[index]
              if (!currentComment) {
                currentComment = cc.parent
              }
            } else {
              const index = comments.indexOf(currentComment)
              comments.splice(index, 1)
              setupNextPreviousLinks(comments)
              currentComment = comments[index]
            }
            console.log('Deleted the comment!')
          } else {
            console.log('Okay, the comment wasn\'t deleted.')
          }
        }
      } : undefined,

      r: (us && cc) ? commentsEnabled ? {
        help: 'Reply to this comment.',
        longcodes: ['reply'],
        action: async () => {
          const reply = await commentPrompt({rl, us, pageType, pageId,
            commenteeId: currentComment.authorId,
            parent: currentComment.threadTopComment,
            promptStr: `Reply with, as ${us.username}: `
          })

          if (reply) {
            const replies = currentComment.parent ? currentComment.parent.replies : currentComment.replies
            replies.push(reply)
            setupNextPreviousLinks(replies)

            currentComment = reply
          }
        }
      } : commentsDisabledChoice : undefined
    })
  }
}

async function fetchComments(type, id, page = 1, jumpTo = null) {
  const comments = await (
    fetch(`${util.urls.siteAPI}/comments/${type}/${id}/?page=${page}&limit=${PAGE_LENGTH}`)
      .then(res => res.text())
      .then(html => parseComments(html))
  )

  if (jumpTo) {
    const jumpedComment = findComment(comments, jumpTo)
    if (jumpedComment) {
      return {comments, jumpedComment}
    } else {
      if (comments.length) {
        process.stdout.write('.') // For the progress bar.
        const res = await fetchComments(type, id, page + 1, jumpTo)
        return {
          comments: setupNextPreviousLinks(comments.concat(res.comments)),
          jumpedComment: res.jumpedComment,
          pageNum: res.pageNum
        }
      } else {
        return {comments, jumpedComment: null, pageNum: page}
      }
    }
  } else {
    return {comments, pageNum: page}
  }
}

function findComment(comments, id) {
  return comments
    .reduce((acc, c) => acc.concat([c], c.replies), [])
    .find(c => c.id.toString() === id.toString())
}

function parseComments(html) {
  const $ = cheerio.load(html)

  return setupNextPreviousLinks($('.top-level-reply').map((i, threadEl) => {
    const commentEl = $(threadEl).find('> .comment')
    const comment = parseCommentEl(commentEl, {$})
    Object.assign(comment, {
      threadTopComment: comment,
      replies: setupNextPreviousLinks($(threadEl).find('.reply .comment').map(
        (i, replyEl) => Object.assign(parseCommentEl(replyEl, {$}), {
          parent: comment,
          threadTopComment: comment
        })
      ).get().filter(c => c.content !== '[deleted]'))
    })
    return comment
  }).get().filter(c => c.content !== '[deleted]'))
}

function parseCommentEl(commentEl, {$}) {
  return {
    author: $(commentEl).find('.name a').text(),
    authorId: $(commentEl).find('.reply').attr('data-commentee-id'),
    content: util.trimWhitespace($(commentEl).find('.content').text()),
    id: $(commentEl).attr('data-comment-id'),
    date: new Date($(commentEl).find('.time').attr('title'))
  }
}

function setupNextPreviousLinks(comments) {
  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i]
    if (i > 0) {
      comment.previous = comments[i - 1]
    }
    if (i < comments.length - 1) {
      comment.next = comments[i + 1]
    }
  }
  return comments
}

async function commentPrompt({rl, us, pageType, pageId, commenteeId, parent, promptStr}) {
  const message = await util.prompt(rl, promptStr)

  if (message.length > 500) {
    console.log('Message too long (> 500 characters).')
    return
  }

  if (message.trim().length === 0) {
    console.log('Not sending reply (empty input).')
    return
  }

  const reply = await postComment({pageType, pageId, us,
    content: message, commenteeId, parent
  })

  return reply
}

function postComment({pageType, pageId, content, us, commenteeId = '', parent = null}) {
  return fetch(`${util.urls.siteAPI}/comments/${pageType}/${pageId}/add/`, {
    method: 'POST',
    body: JSON.stringify(util.clearBlankProperties({
      content,
      commentee_id: commenteeId || '',
      parent_id: parent ? parent.id : ''
    })),
    headers: util.makeFetchHeaders(us)
  }).then(res => {
    if (res.status === 200) {
      return res.text().then(text => {
        const $ = cheerio.load(text)
        const comment = parseCommentEl($('.comment'), {$})
        Object.assign(comment, util.clearBlankProperties({
          parent: parent ? parent : undefined,
          threadTopComment: parent ? parent : comment
        }))
        return comment
      })
    } else {
      return res.text().then(text => {
        console.log(text)
        throw new Error(res.status)
      })
    }
  })
}
