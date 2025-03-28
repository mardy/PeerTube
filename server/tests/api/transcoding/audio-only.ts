/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import { expect } from 'chai'
import { getAudioStream, getVideoStreamDimensionsInfo } from '@server/helpers/ffmpeg'
import {
  cleanupTests,
  createMultipleServers,
  doubleFollow,
  PeerTubeServer,
  setAccessTokensToServers,
  waitJobs
} from '@shared/server-commands'

describe('Test audio only video transcoding', function () {
  let servers: PeerTubeServer[] = []
  let videoUUID: string
  let webtorrentAudioFileUrl: string
  let fragmentedAudioFileUrl: string

  before(async function () {
    this.timeout(120000)

    const configOverride = {
      transcoding: {
        enabled: true,
        resolutions: {
          '0p': true,
          '144p': false,
          '240p': true,
          '360p': false,
          '480p': false,
          '720p': false,
          '1080p': false,
          '1440p': false,
          '2160p': false
        },
        hls: {
          enabled: true
        },
        webtorrent: {
          enabled: true
        }
      }
    }
    servers = await createMultipleServers(2, configOverride)

    // Get the access tokens
    await setAccessTokensToServers(servers)

    // Server 1 and server 2 follow each other
    await doubleFollow(servers[0], servers[1])
  })

  it('Should upload a video and transcode it', async function () {
    this.timeout(120000)

    const { uuid } = await servers[0].videos.upload({ attributes: { name: 'audio only' } })
    videoUUID = uuid

    await waitJobs(servers)

    for (const server of servers) {
      const video = await server.videos.get({ id: videoUUID })
      expect(video.streamingPlaylists).to.have.lengthOf(1)

      for (const files of [ video.files, video.streamingPlaylists[0].files ]) {
        expect(files).to.have.lengthOf(3)
        expect(files[0].resolution.id).to.equal(720)
        expect(files[1].resolution.id).to.equal(240)
        expect(files[2].resolution.id).to.equal(0)
      }

      if (server.serverNumber === 1) {
        webtorrentAudioFileUrl = video.files[2].fileUrl
        fragmentedAudioFileUrl = video.streamingPlaylists[0].files[2].fileUrl
      }
    }
  })

  it('0p transcoded video should not have video', async function () {
    const paths = [
      servers[0].servers.buildWebTorrentFilePath(webtorrentAudioFileUrl),
      servers[0].servers.buildFragmentedFilePath(videoUUID, fragmentedAudioFileUrl)
    ]

    for (const path of paths) {
      const { audioStream } = await getAudioStream(path)
      expect(audioStream['codec_name']).to.be.equal('aac')
      expect(audioStream['bit_rate']).to.be.at.most(384 * 8000)

      const size = await getVideoStreamDimensionsInfo(path)
      expect(size).to.not.exist
    }
  })

  after(async function () {
    await cleanupTests(servers)
  })
})
