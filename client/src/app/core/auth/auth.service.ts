import { Hotkey, HotkeysService } from 'angular2-hotkeys'
import { Observable, ReplaySubject, Subject, throwError as observableThrowError } from 'rxjs'
import { catchError, map, mergeMap, share, tap } from 'rxjs/operators'
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http'
import { Injectable } from '@angular/core'
import { Router } from '@angular/router'
import { Notifier } from '@app/core/notification/notifier.service'
import { logger, objectToUrlEncoded, peertubeLocalStorage, UserTokens } from '@root-helpers/index'
import { HttpStatusCode, MyUser as UserServerModel, OAuthClientLocal, User, UserLogin, UserRefreshToken } from '@shared/models'
import { environment } from '../../../environments/environment'
import { RestExtractor } from '../rest/rest-extractor.service'
import { AuthStatus } from './auth-status.model'
import { AuthUser } from './auth-user.model'

interface UserLoginWithUsername extends UserLogin {
  access_token: string
  refresh_token: string
  token_type: string
  username: string
}

type UserLoginWithUserInformation = UserLoginWithUsername & User

@Injectable()
export class AuthService {
  private static BASE_CLIENT_URL = environment.apiUrl + '/api/v1/oauth-clients/local'
  private static BASE_TOKEN_URL = environment.apiUrl + '/api/v1/users/token'
  private static BASE_REVOKE_TOKEN_URL = environment.apiUrl + '/api/v1/users/revoke-token'
  private static BASE_USER_INFORMATION_URL = environment.apiUrl + '/api/v1/users/me'
  private static LOCAL_STORAGE_OAUTH_CLIENT_KEYS = {
    CLIENT_ID: 'client_id',
    CLIENT_SECRET: 'client_secret'
  }

  loginChangedSource: Observable<AuthStatus>
  userInformationLoaded = new ReplaySubject<boolean>(1)
  tokensRefreshed = new ReplaySubject<void>(1)
  hotkeys: Hotkey[]

  private clientId: string = peertubeLocalStorage.getItem(AuthService.LOCAL_STORAGE_OAUTH_CLIENT_KEYS.CLIENT_ID)
  private clientSecret: string = peertubeLocalStorage.getItem(AuthService.LOCAL_STORAGE_OAUTH_CLIENT_KEYS.CLIENT_SECRET)
  private loginChanged: Subject<AuthStatus>
  private user: AuthUser = null
  private refreshingTokenObservable: Observable<any>

  constructor (
    private http: HttpClient,
    private notifier: Notifier,
    private hotkeysService: HotkeysService,
    private restExtractor: RestExtractor,
    private router: Router
  ) {
    this.loginChanged = new Subject<AuthStatus>()
    this.loginChangedSource = this.loginChanged.asObservable()

    // Set HotKeys
    this.hotkeys = [
      new Hotkey('m s', (event: KeyboardEvent): boolean => {
        this.router.navigate([ '/videos/subscriptions' ])
        return false
      }, undefined, $localize`Go to my subscriptions`),
      new Hotkey('m v', (event: KeyboardEvent): boolean => {
        this.router.navigate([ '/my-library/videos' ])
        return false
      }, undefined, $localize`Go to my videos`),
      new Hotkey('m i', (event: KeyboardEvent): boolean => {
        this.router.navigate([ '/my-library/video-imports' ])
        return false
      }, undefined, $localize`Go to my imports`),
      new Hotkey('m c', (event: KeyboardEvent): boolean => {
        this.router.navigate([ '/my-library/video-channels' ])
        return false
      }, undefined, $localize`Go to my channels`)
    ]
  }

  buildAuthUser (userInfo: Partial<User>, tokens: UserTokens) {
    this.user = new AuthUser(userInfo, tokens)
  }

  loadClientCredentials () {
    // Fetch the client_id/client_secret
    this.http.get<OAuthClientLocal>(AuthService.BASE_CLIENT_URL)
        .pipe(catchError(res => this.restExtractor.handleError(res)))
        .subscribe({
          next: res => {
            this.clientId = res.client_id
            this.clientSecret = res.client_secret

            peertubeLocalStorage.setItem(AuthService.LOCAL_STORAGE_OAUTH_CLIENT_KEYS.CLIENT_ID, this.clientId)
            peertubeLocalStorage.setItem(AuthService.LOCAL_STORAGE_OAUTH_CLIENT_KEYS.CLIENT_SECRET, this.clientSecret)

            logger.info('Client credentials loaded.')
          },

          error: err => {
            let errorMessage = err.message

            if (err.status === HttpStatusCode.FORBIDDEN_403) {
              errorMessage = $localize`Cannot retrieve OAuth Client credentials: ${err.message}.
Ensure you have correctly configured PeerTube (config/ directory), in particular the "webserver" section.`
            }

            // We put a bigger timeout: this is an important message
            this.notifier.error(errorMessage, $localize`Error`, 7000)
          }
        })
  }

  getRefreshToken () {
    if (this.user === null) return null

    return this.user.getRefreshToken()
  }

  getRequestHeaderValue () {
    const accessToken = this.getAccessToken()

    if (accessToken === null) return null

    return `${this.getTokenType()} ${accessToken}`
  }

  getAccessToken () {
    if (this.user === null) return null

    return this.user.getAccessToken()
  }

  getTokenType () {
    if (this.user === null) return null

    return this.user.getTokenType()
  }

  getUser () {
    return this.user
  }

  isLoggedIn () {
    return !!this.getAccessToken()
  }

  login (username: string, password: string, token?: string) {
    // Form url encoded
    const body = {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      response_type: 'code',
      grant_type: 'password',
      scope: 'upload',
      username,
      password
    }

    if (token) Object.assign(body, { externalAuthToken: token })

    const headers = new HttpHeaders().set('Content-Type', 'application/x-www-form-urlencoded')
    return this.http.post<UserLogin>(AuthService.BASE_TOKEN_URL, objectToUrlEncoded(body), { headers })
               .pipe(
                 map(res => Object.assign(res, { username })),
                 mergeMap(res => this.mergeUserInformation(res)),
                 map(res => this.handleLogin(res)),
                 catchError(res => this.restExtractor.handleError(res))
               )
  }

  logout () {
    const authHeaderValue = this.getRequestHeaderValue()
    const headers = new HttpHeaders().set('Authorization', authHeaderValue)

    this.http.post<{ redirectUrl?: string }>(AuthService.BASE_REVOKE_TOKEN_URL, {}, { headers })
      .subscribe({
        next: res => {
          if (res.redirectUrl) {
            window.location.href = res.redirectUrl
          }
        },

        error: err => logger.error(err)
      })

    this.user = null

    this.setStatus(AuthStatus.LoggedOut)

    this.hotkeysService.remove(this.hotkeys)
  }

  refreshAccessToken () {
    if (this.refreshingTokenObservable) return this.refreshingTokenObservable

    logger.info('Refreshing token...')

    const refreshToken = this.getRefreshToken()

    // Form url encoded
    const body = new HttpParams().set('refresh_token', refreshToken)
                                 .set('client_id', this.clientId)
                                 .set('client_secret', this.clientSecret)
                                 .set('response_type', 'code')
                                 .set('grant_type', 'refresh_token')

    const headers = new HttpHeaders().set('Content-Type', 'application/x-www-form-urlencoded')

    this.refreshingTokenObservable = this.http.post<UserRefreshToken>(AuthService.BASE_TOKEN_URL, body, { headers })
                                         .pipe(
                                           map(res => this.handleRefreshToken(res)),
                                           tap(() => {
                                             this.refreshingTokenObservable = null
                                           }),
                                           catchError(err => {
                                             this.refreshingTokenObservable = null

                                             logger.error(err)
                                             logger.info('Cannot refresh token -> logout...')
                                             this.logout()
                                             this.router.navigate([ '/login' ])

                                             return observableThrowError(() => ({
                                               error: $localize`You need to reconnect.`
                                             }))
                                           }),
                                           share()
                                         )

    return this.refreshingTokenObservable
  }

  refreshUserInformation () {
    const obj: UserLoginWithUsername = {
      access_token: this.user.getAccessToken(),
      refresh_token: null,
      token_type: this.user.getTokenType(),
      username: this.user.username
    }

    this.mergeUserInformation(obj)
        .subscribe({
          next: res => {
            this.user.patch(res)

            this.userInformationLoaded.next(true)
          }
        })
  }

  private mergeUserInformation (obj: UserLoginWithUsername): Observable<UserLoginWithUserInformation> {
    // User is not loaded yet, set manually auth header
    const headers = new HttpHeaders().set('Authorization', `${obj.token_type} ${obj.access_token}`)

    return this.http.get<UserServerModel>(AuthService.BASE_USER_INFORMATION_URL, { headers })
               .pipe(map(res => Object.assign(obj, res)))
  }

  private handleLogin (obj: UserLoginWithUserInformation) {
    const hashTokens = {
      accessToken: obj.access_token,
      tokenType: obj.token_type,
      refreshToken: obj.refresh_token
    }

    this.user = new AuthUser(obj, hashTokens)

    this.setStatus(AuthStatus.LoggedIn)
    this.userInformationLoaded.next(true)

    this.hotkeysService.add(this.hotkeys)
  }

  private handleRefreshToken (obj: UserRefreshToken) {
    this.user.refreshTokens(obj.access_token, obj.refresh_token)
    this.tokensRefreshed.next()
  }

  private setStatus (status: AuthStatus) {
    this.loginChanged.next(status)
  }
}
