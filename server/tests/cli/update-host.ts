/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import { expect } from 'chai'
import { getAllFiles } from '@shared/core-utils'
import {
  cleanupTests,
  createSingleServer,
  killallServers,
  makeActivityPubGetRequest,
  parseTorrentVideo,
  PeerTubeServer,
  setAccessTokensToServers,
  waitJobs
} from '@shared/server-commands'

describe('Test update host scripts', function () {
  let server: PeerTubeServer

  before(async function () {
    this.timeout(60000)

    const overrideConfig = {
      webserver: {
        port: 9256
      }
    }
    // Run server 2 to have transcoding enabled
    server = await createSingleServer(2, overrideConfig)
    await setAccessTokensToServers([ server ])

    // Upload two videos for our needs
    const { uuid: video1UUID } = await server.videos.upload()
    await server.videos.upload()

    // Create a user
    await server.users.create({ username: 'toto', password: 'coucou' })

    // Create channel
    const videoChannel = {
      name: 'second_channel',
      displayName: 'second video channel',
      description: 'super video channel description'
    }
    await server.channels.create({ attributes: videoChannel })

    // Create comments
    const text = 'my super first comment'
    await server.comments.createThread({ videoId: video1UUID, text })

    await waitJobs(server)
  })

  it('Should run update host', async function () {
    this.timeout(30000)

    await killallServers([ server ])
    // Run server with standard configuration
    await server.run()

    await server.cli.execWithEnv(`npm run update-host`)
  })

  it('Should have updated videos url', async function () {
    const { total, data } = await server.videos.list()
    expect(total).to.equal(2)

    for (const video of data) {
      const { body } = await makeActivityPubGetRequest(server.url, '/videos/watch/' + video.uuid)

      expect(body.id).to.equal('http://localhost:9002/videos/watch/' + video.uuid)

      const videoDetails = await server.videos.get({ id: video.uuid })

      expect(videoDetails.trackerUrls[0]).to.include(server.host)
      expect(videoDetails.streamingPlaylists[0].playlistUrl).to.include(server.host)
      expect(videoDetails.streamingPlaylists[0].segmentsSha256Url).to.include(server.host)
    }
  })

  it('Should have updated video channels url', async function () {
    const { data, total } = await server.channels.list({ sort: '-name' })
    expect(total).to.equal(3)

    for (const channel of data) {
      const { body } = await makeActivityPubGetRequest(server.url, '/video-channels/' + channel.name)

      expect(body.id).to.equal('http://localhost:9002/video-channels/' + channel.name)
    }
  })

  it('Should have updated accounts url', async function () {
    const body = await server.accounts.list()
    expect(body.total).to.equal(3)

    for (const account of body.data) {
      const usernameWithDomain = account.name
      const { body } = await makeActivityPubGetRequest(server.url, '/accounts/' + usernameWithDomain)

      expect(body.id).to.equal('http://localhost:9002/accounts/' + usernameWithDomain)
    }
  })

  it('Should have updated torrent hosts', async function () {
    this.timeout(30000)

    const { data } = await server.videos.list()
    expect(data).to.have.lengthOf(2)

    for (const video of data) {
      const videoDetails = await server.videos.get({ id: video.id })
      const files = getAllFiles(videoDetails)

      expect(files).to.have.lengthOf(8)

      for (const file of files) {
        expect(file.magnetUri).to.contain('localhost%3A9002%2Ftracker%2Fsocket')
        expect(file.magnetUri).to.contain('localhost%3A9002%2Fstatic%2F')

        const torrent = await parseTorrentVideo(server, file)
        const announceWS = torrent.announce.find(a => a === 'ws://localhost:9002/tracker/socket')
        expect(announceWS).to.not.be.undefined

        const announceHttp = torrent.announce.find(a => a === 'http://localhost:9002/tracker/announce')
        expect(announceHttp).to.not.be.undefined

        expect(torrent.urlList[0]).to.contain('http://localhost:9002/static/')
      }
    }
  })

  after(async function () {
    await cleanupTests([ server ])
  })
})
